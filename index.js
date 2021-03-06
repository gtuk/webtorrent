// TODO: move vlc/airplay/etc. functionality from cmd.js to the module

module.exports = WebTorrent

var Client = require('bittorrent-client')
var concat = require('concat-stream')
var debug = require('debug')('webtorrent')
var extend = require('extend.js')
var fs = require('fs')
var FSStorage = require('./lib/fs-storage')
var http = require('http')
var inherits = require('inherits')
var mime = require('mime')
var parallel = require('run-parallel')
var parseTorrent = require('parse-torrent')
var pump = require('pump')
var rangeParser = require('range-parser')
var url = require('url')
var gzip = require('zlib').Gunzip()


inherits(WebTorrent, Client)

function WebTorrent (opts) {
  var self = this
  opts = opts || {}
  debug('new webtorrent')
  if (opts.blocklist) opts.blocklist = parseBlocklist(opts.blocklist)

  Client.call(self, opts)
  self.listening = false

  if (opts.list) return

  if (opts.port !== false) {
    // start http server
    self.server = http.createServer()
    self.server.on('connection', function (socket) {
      socket.setTimeout(36000000)
    })
    self.server.on('request', self._onRequest.bind(self))
    self.server.listen(opts.port)
    self.server.once('listening', function () {
      self.listening = true
      self.emit('listening')
    })
  }

  self.on('torrent', self._onTorrent.bind(self))
}

/**
 * Add a new torrent to the client. `torrentId` can be one of:
 *
 * - magnet uri (utf8 string)
 * - torrent file (buffer)
 * - info hash (hex string or buffer)
 * - parsed torrent (from parse-torrent module)
 * - http/https url to a .torrent file (string)
 * - filesystem path to a .torrent file (string)
 *
 * @override
 * @param {string|Buffer|Object} torrentId torrent (choose from above list)
 * @param {Object}               opts      optional torrent-specific options
 * @param {function=}            ontorrent called when the torrent is ready (has metadata)
 */
WebTorrent.prototype.add = function (torrentId, opts, ontorrent) {
  var self = this

  if (typeof opts === 'function') {
    ontorrent = opts
    opts = {}
  }

  debug('add %s', torrentId)

  opts = extend({
    storage: FSStorage
  }, opts)

  // TODO: fix this to work with multiple torrents
  self.index = opts.index

  // Called once we have a torrentId that bittorrent-client can handle
  function onTorrentId (torrentId) {
    var torrent = Client.prototype.add.call(self, torrentId, opts, ontorrent)
    process.nextTick(function () {
      self.emit('add', torrent)
    })
  }

  var parsed = parseTorrent(torrentId)
  if (parsed && parsed.infoHash) {
    // magnet uri, info hash, torrent file, or parsed torrent can be handled by bittorrent-client
    process.nextTick(function () {
      onTorrentId(parsed)
    })
  } else if (/^https?:/.test(torrentId)) {
    // http or https url to torrent file
    http.get(torrentId, function (res) {
      res.pipe(concat(function (torrent) {
        onTorrentId(torrent)
      }))
    }).on('error', function (err) {
      self.emit('error', new Error('Error downloading torrent. ' + err.message))
    })
  } else {
    // assume it's a filesystem path
    fs.readFile(torrentId, function (err, torrent) {
      if (err) {
        self.emit('error', new Error('Invalid torrent. Need magnet uri, info hash, ' +
          'torrent file, http url, or filesystem path.'))
      } else {
        onTorrentId(torrent)
      }
    })
  }

  return self
}

/**
 * Destroy the client, including all torrents and connections to peers.
 *
 * @override
 * @param  {function} cb
 */
WebTorrent.prototype.destroy = function (cb) {
  var self = this
  debug('destroy')
  var tasks = [
    Client.prototype.destroy.bind(self)
  ]

  if (self.server) {
    tasks.push(function (cb) {
      try {
        self.server.close(cb)
      } catch (err) {
        // ignore error, server was already closed or not listening
        cb(null)
      }
    })
  }

  parallel(tasks, cb)
  return self
}

WebTorrent.prototype._onTorrent = function (torrent) {
  var self = this
  debug('on torrent')

  // if no index specified, use largest file
  if (typeof torrent.index !== 'number') {
    var largestFile = torrent.files.reduce(function (a, b) {
      return a.length > b.length ? a : b
    })
    torrent.index = torrent.files.indexOf(largestFile)
  }

  torrent.files[torrent.index].select()

  // TODO: this won't work with multiple torrents
  self.index = torrent.index
  self.torrent = torrent
}

WebTorrent.prototype._onRequest = function (req, res) {
  var self = this
  debug('onRequest')

  var u = url.parse(req.url)
  if (u.pathname === '/favicon.ico') return res.end()
  if (u.pathname === '/') u.pathname = '/' + self.index
  var i = Number(u.pathname.slice(1))

  if (isNaN(i) || i >= self.torrent.files.length) {
    res.statusCode = 404
    return res.end()
  }

  if (self.torrent) onTorrent(self.torrent)
  else self.once('torrent', onTorrent)

  function onTorrent (torrent) {
    var file = torrent.files[i]

    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', mime.lookup(file.name))
    res.statusCode = 206

    var range
    if (req.headers.range) {
      // no support for multi-range reqs
      range = rangeParser(file.length, req.headers.range)[0]
      debug('range %s', JSON.stringify(range))
      res.setHeader(
        'Content-Range',
        'bytes ' + range.start + '-' + range.end + '/' + file.length
      )
      res.setHeader('Content-Length', range.end - range.start + 1)
    } else {
      res.setHeader('Content-Length', file.length)
    }
    if (req.method === 'HEAD') res.end()
    pump(file.createReadStream(range), res)
  }
}

var blocklistRe = /^\s*[^#].*?\s*:\s*([a-f0-9.:]+?)\s*-\s*([a-f0-9.:]+?)\s*$/
function parseBlocklist (filename) {
  if( filename.substring(filename.lastIndexOf('.')+1) == 'gz' ) {
    var input = fs.createReadStream(filename);
    filename = filename.substring(0, filename.lastIndexOf('.'))+'.txt'
    var output = fs.createWriteStream(filename);

    var result = input.pipe(gzip).pipe(output);
    result.on('finish', function () {
        var blocklistData = fs.readFileSync(filename, 'utf8')
        var blocklist = []
        blocklistData.split('\n').forEach(function (line) {
          var match = blocklistRe.exec(line)
          if (match) blocklist.push({ start: match[1], end: match[2] })
        })
        return blocklist
    })
  }
  else {
    var blocklistData = fs.readFileSync(filename, 'utf8')
    var blocklist = []
    blocklistData.split('\n').forEach(function (line) {
      var match = blocklistRe.exec(line)
      if (match) blocklist.push({ start: match[1], end: match[2] })
    })
    return blocklist
  }
}
