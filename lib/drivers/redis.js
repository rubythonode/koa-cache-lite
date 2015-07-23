'use strict'

try {
  var events = require('events')
  var Redis = require('ioredis')
  var util = require('util')
}
catch(error) {
  throw new Error('Please install ioredis manually (optional dependency)')
}

function Driver() {
  events.EventEmitter.call(this)
  if (false === (this instanceof Driver)) return new Driver()
}

util.inherits(Driver, events.EventEmitter)

Driver.prototype.connect = function(_opts) {
  var self = this
  this.opts = _opts
  this.conn = new Redis(this.opts.port || '127.0.0.1', this.opts.host || 6379, {
    autoResendUnfulfilledCommands: false,
    retryStrategy: function(times) {
      if (self.opts.debug) console.info('connection with redis failed', times, 'times')

      if (times == 1 && !self.conn._lock) self.conn._lock = true

      if (times == 5) {
        self.emit('fail')
        return false
      }

      return 1*1000
    }
  })

  this.conn.on('ready', function() {
    if (self.opts.debug) console.info('using Redis for caching')
    if (self.conn._lock) self.conn._lock = false
  })
}

Driver.prototype.get = function(key) {
  return this.conn.get(key)
}

Driver.prototype.has = function(key) {
  return this.conn.exists(key).then(function(check) {
    if (check > 0) return Promise.resolve(true)
    else return Promise.resolve(false)
  })
}

Driver.prototype.set = function(key, value, timeout) {
  var self = this

  if (this.opts.debug) console.info('setting new item in cache for url', key)

  return this.conn.set(key, JSON.stringify(value)).then(function() {
    return self.conn.expire(key, function(opts) {
      if (opts.expireOpts.has(key)) return opts.expireOpts.get(key) / 1000
      return opts.defaultTimeout / 1000
    }(self.opts))
  })
}

module.exports = Driver