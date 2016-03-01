'use strict'

var Store = require('./lib/store')
var responseKeys = [ 'status', 'message', 'header', 'body' ]

module.exports = (routes, opts) => {
  if (opts.debug) console.info('cache options:', routes, opts)

  opts.expireOpts = new Map()
  opts.defaultTimeout = 5000
  var store = new Store(opts)

  for (let key of Object.keys(routes)) {
    // validate and reorganize route values
    if (typeof routes[key] !== 'object'
      && typeof routes[key] !== 'boolean'
      && routes[key] !== 'increasing'
      && isNaN(routes[key])) {

      if (opts.debug) console.info('invalid value for key', key)

      delete routes[key]
      continue
    }

    if (!isNaN(routes[key]))
      routes[key] = {
        timeout: routes[key]
      }
    else if (routes[key] === 'increasing') {
      routes[key] = {
        timeout: 'increasing'
      }

      if (!opts.callCnt) opts.callCnt = new Map()
    }

    if (routes[key].cacheKeyArgs instanceof Array) {
      if (opts.debug) console.info('cacheKeyArgs of array type not supported:', key)
      delete routes[key]
      continue
    }

    if (typeof routes[key].cacheKeyArgs === 'string') {
      routes[key].cacheKeyArgs = {
        custom: routes[key].cacheKeyArgs
      }
    }

    if (routes[key].cacheKeyArgs && typeof routes[key].cacheKeyArgs.headers === 'string') {
      routes[key].cacheKeyArgs.headers = [ routes[key].cacheKeyArgs.headers ]
    }

    if (routes[key].cacheKeyArgs && typeof routes[key].cacheKeyArgs.query === 'string') {
      routes[key].cacheKeyArgs.query = [ routes[key].cacheKeyArgs.query ]
    }

    // parse caching route params
    if (key.indexOf(':') !== -1) {
      routes[key]['regex'] = new RegExp(
        key.replace(/:[A-z0-9]+/g, '[A-z0-9]+')
        .replace(/^\//, '^\/')
        .replace(/$/, '(?:\/)?$')
        .replace(/\//g, '\\/'))

    }

    if (key.indexOf('*') !== -1) {
      routes[key]['regex'] = new RegExp(
        key.replace('*', '.*'))
    }
  }

  let routeKeys = Object.keys(routes)
  let routeKeysLength = routeKeys.length

  // set default increasing options if not defined
  if (opts.callCnt) {
    if (opts.increasing === undefined) {
      opts.increasing = {
        1: 1000,
        3: 2000,
        10: 3000,
        20: 4000,
        50: 5000
      }
    }

    var cntStep = Object.keys(opts.increasing)

    for (let key of cntStep) {
      if (typeof opts.increasing[key] === 'string') {
        if (opts.increasing[key].search(/[0-9]+s$/) !== -1)
          opts.increasing[key] = Number(opts.increasing[key].replace('s', '')) * 1000
        else if (opts.increasing[key].search(/[0-9]+m$/) !== -1)
          opts.increasing[key] = Number(opts.increasing[key].replace('m', '')) * 60000
        else if (opts.increasing[key].search(/[0-9]+h$/) !== -1)
          opts.increasing[key] = Number(opts.increasing[key].replace('h', '')) * 60000 * 60
        else if (opts.increasing[key].search(/[0-9]+d$/) !== -1)
          opts.increasing[key] = Number(opts.increasing[key].replace('d', '')) * 60000 * 60 * 24
        else {
          if (opts.debug) console.info('increasing timeout value invalid:', opts.increasing[key])
          delete opts.increasing[key]
        }
      }
    }

    // clear call hit counter every minute
    setInterval(() => {
      if (opts.debug) console.info('clearing call hit counter')
      opts.callCnt = new Map()
    }, 60000)
  }

  return function *(next) {
    try {
      // check if route is permitted to be cached FIXME?
      if (!routeKeysLength) return yield next;

      // create key
      let requestKey = this.request.path

      for (let i = 0; i < routeKeysLength; i++) {
        let key = routeKeys[i]

        // first pass - exact match
        if (key === this.request.path) {
          if (opts.debug)
            console.info('exact matched route:', this.request.path)

          if (routes[key].cacheKeyArgs)
            requestKey = yield setRequestKey(requestKey, key, this.request)

          let ok = yield setExpires(i, requestKey)
          if (!ok) return yield next

          break
        }
        else if (!routes[routeKeys[i]].regex) continue

        // second pass - regex match
        else if (routes[routeKeys[i]].regex.test(this.request.path)) {
          if (opts.debug)
            console.info('regex matched route:', this.request.url, routes[routeKeys[i]].regex)

          if (routes[key].cacheKeyArgs)
            requestKey = yield setRequestKey(requestKey, key, this.request)

          let ok = yield setExpires(i, requestKey)
          if (!ok) return yield next

          break
        }

        if (i === routeKeys.length - 1) return yield next
        else continue
      }

      // check if no-cache is provided
      if (this.request.header['cache-control'] === 'no-cache') {
        return yield next
      }

      // check if HTTP methods other than GET are sent and invalidate cache if true
      if (this.request.method != 'GET') {
        for (let i = 0; i < routeKeysLength; i++) {
          let key = routeKeys[i]

          if (requestKey.indexOf(key) != -1) {
            store.delete(requestKey)
          }
        }
        return yield next
      }

      // return cached response
      let exists = yield store.has(requestKey + ':headers')

      if (exists) {
        let headers = yield store.get(requestKey + ':headers')
        let body = yield store.get(requestKey + ':body')

        if ('string' === typeof(headers)) headers = JSON.parse(headers)
        if (opts.debug) console.info('returning from cache for url', requestKey)

        for (let key in headers) {
          if (key === 'header') {
            let value = headers[key]

            for (let hkey in value) {
              this.set(hkey, value[hkey])
            }

            continue
          }

          this[key] = headers[key]
        }

        if (body) this['body'] = body

        return
      }

      // call next middleware and cache response on return
      yield next

      let _response_body, _response_headers = new Object()

      for (let key in this.response) {
        if (key === 'body') continue

        if (responseKeys.indexOf(key) !== -1)
          _response_headers[key] = this.response[key]
      }

      if (this.response.body)
        _response_body = this.response.body

      if (opts.debug) console.info('caching', requestKey)

      // set new caching entry
      let storeRequest = {}
      storeRequest[requestKey + ':headers'] = JSON.stringify(_response_headers)
      storeRequest[requestKey + ':body'] = _response_body

      store.setMultiple(requestKey, storeRequest)
    }
    catch (error) {
      if (opts.debug) console.error(error)
      this.throw(error)
    }
  }

  function *setExpires(routeKeysIndex, requestKey) {
    let routeExpire = routes[routeKeys[routeKeysIndex]].timeout

    if (routeExpire === false) {
      return false
    }

    // override default timeout
    if (typeof routeExpire === 'boolean') routeExpire = opts.defaultTimeout
    else if (routeExpire === 'increasing' && opts.increasing) {
      let count = opts.callCnt.has(requestKey)

      if (count) {
        count = opts.callCnt.get(requestKey) + 1
        opts.callCnt.set(requestKey, count)
        let steps = cntStep.length

        for (let i = 0; i < steps; i++) {
          if (count === cntStep[i]) {
            opts.expireOpts.set(requestKey, opts.increasing[cntStep[i]])
            break
          }
        }
      }
      else {
        opts.callCnt.set(requestKey, 1)
        opts.expireOpts.set(requestKey, opts.increasing[cntStep[0]])
      }
    }
    else opts.expireOpts.set(requestKey, routeExpire)

    return true
  }

  function *setRequestKey(requestKey, routeKey, ctx) {
    // append specified http headers to requestKey
    if (routes[routeKey].cacheKeyArgs.headers instanceof Array) {
      requestKey += '#'

      for (let name of routes[routeKey].cacheKeyArgs.headers) {
        requestKey += ctx.header[name]
      }
    }

    // ...or append all http headers to requestKey
    else if (routes[routeKey].cacheKeyArgs.headers === true) {
      requestKey += '#'

      for (let name of Object.keys(ctx.headers)) {
        requestKey += ctx.headers[name]
      }
    }

    // append specified http url query parameters to requestKey
    if (routes[routeKey].cacheKeyArgs.query instanceof Array) {
      requestKey += '?'

      for (let name of Object.keys(ctx.query)) {
        requestKey += ctx.query[name]
      }
    }

    // ...or append all http url query parameters to requestKey
    else if (routes[routeKey].cacheKeyArgs.query === true)
      requestKey += '?' + ctx.querystring

    return requestKey
  }
}
