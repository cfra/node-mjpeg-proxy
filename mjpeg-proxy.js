// Copyright (C) 2013, Georges-Etienne Legendre <legege@legege.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var url = require('url');
var http = require('http');

require('buffertools');

function extractBoundary(contentType) {
  var startIndex = contentType.indexOf('boundary=');
  var endIndex = contentType.indexOf(';', startIndex);
  if (endIndex == -1) { //boundary is the last option
    // some servers, like mjpeg-streamer puts a '\r' character at the end of each line.
    if ((endIndex = contentType.indexOf('\r', startIndex)) == -1) {
      endIndex = contentType.length;
    }
  }
  return contentType.substring(startIndex + 9, endIndex).replace(/"/gi,'');
}

var MjpegProxy = exports.MjpegProxy = function(mjpegUrl, still_frames) {
  var self = this;

  if (!mjpegUrl) throw new Error('Please provide a source MJPEG URL');

  self.mjpegOptions = url.parse(mjpegUrl);
  self.mjpegOptions.agent = false;
  self.still_frames = still_frames;
  self.still_frame_idx = 0;
  self.consumers = [];
  self.boundary = 'ipcamera';
  self.on_air = true;
  self.frames_missed = 50;

  self._handle_data = function(chunk) {
    var p = chunk.indexOf('--' + self.boundary);
    if (p >= 0)
      self.frames_missed = 0;

    if (!self.on_air)
      return;

    for (var i = self.consumers.length; i--;) {
      var res = self.consumers[i];

      if (res.is_live) {
        res.write(chunk);
      } else {
        if (p >= 0) {
          res.write(chunk.slice(p));
          res.is_live = true;
        }
      }
    }
  };

  self._newClient = function(req, res){
    res.writeHead(200, {
      'Expires': 'Mon, 01 Jul 1980 00:00:00 GMT',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Content-Type': 'multipart/x-mixed-replace;boundary=' + self.boundary
    });
    res.is_live = false;

    self.consumers.push(res);

    req.socket.on('close', function() {
      self.consumers.splice(self.consumers.indexOf(res), 1);
    });
  };

  self.proxyRequest = function(req, res) {
    self._newClient(req, res);
  };

  self._start_request = function() {
    self.producer_response = null;
    self.producer_request = http.request(self.mjpegOptions, function(response) {
      self.producer_response = response;
      self.boundary = extractBoundary(response.headers['content-type']);

      response.on('data', self._handle_data);
      response.on('end', function() {
        /* handle end of camera stream */
      });

      response.on('close', function() {
        /* handle close of producer */
      });
    });
    self.producer_request.on('error', function(e) {
      console.log('Error on producer', e);
    });
    self.producer_request.end()
  };

  self.frame_ticker_interval = 240;
  self._frame_ticker = function() {
    self.frames_missed += 1;
    if (self.frames_missed > (1000 / self.frame_ticker_interval)) {
      self.frames_missed = -(10000 / self.frame_ticker_interval);

      console.log("No frames received - restarting producer request.");

      if (self.producer_response)
        self.producer_response.destroy();
      else if (self.producer_request)
        self.producer_request.abort();
      self.producer_request = null;
      self.producer_response = null;
      self._start_request();
    }

    if (self.on_air && self.frames_missed >= 0)
      return;

    self.still_frame_idx++;
    if (self.still_frame_idx >= self.still_frames.length)
        self.still_frame_idx = 0;

    var frame = self.still_frames[self.still_frame_idx];

    var header = '\r\n--' + self.boundary + '\r\n';
    header += 'Content-Type: image/jpeg\r\n';
    header += 'Content-Length: ' + frame.length + '\r\n\r\n';

    var buffer = Buffer.concat([ new Buffer(header), frame ]);

    for (var i = self.consumers.length; i--;) {
      var res = self.consumers[i];

      res.write(buffer);
      res.is_live = true;
    }
  };
  self.frame_ticker_id = setInterval(self._frame_ticker, self.frame_ticker_interval);
}
