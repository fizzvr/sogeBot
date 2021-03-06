/* @flow */

'use strict'
require('module-alias/register')

const figlet = require('figlet')
const cluster = require('cluster')
const TwitchJs = require('twitch-js').default
const os = require('os')
const util = require('util')
const _ = require('lodash')
const chalk = require('chalk')
const moment = require('moment')

const constants = require('./constants')
const config = require('@config')

global.commons = new (require('./commons'))()
global.cache = new (require('./cache'))()

global.linesParsed = 0
global.avgResponse = []

let ignoreGiftsFromUser: { [string]: { count: Number, time: Date }} = {}

global.status = { // TODO: move it?
  'TMI': constants.DISCONNECTED,
  'API': constants.DISCONNECTED,
  'MOD': false,
  'RES': 0
}

require('./logging') // logger is on master / worker have own global.log sending data through process

global.db = new (require('./databases/database'))(true)
if (cluster.isMaster) {
  // spin up forks first
  global.cpu = config.cpu === 'auto' ? os.cpus().length : parseInt(_.get(config, 'cpu', 1), 10)
  if (config.database.type === 'nedb') global.cpu = 1 // nedb can have only one fork
  for (let i = 0; i < global.cpu; i++) fork()
  cluster.on('disconnect', (worker) => fork())
  main()
} else {
  require('./cluster.js')
}

async function main () {
  if (!global.db.engine.connected) return setTimeout(() => main(), 10)

  global.configuration = new (require('./configuration.js'))()
  global.currency = new (require('./currency.js'))()
  global.stats = new (require('./stats.js'))()
  global.users = new (require('./users.js'))()
  global.logger = new (require('./logging.js'))()

  global.events = new (require('./events.js'))()
  global.customvariables = new (require('./customvariables.js'))()

  global.panel = new (require('./panel'))()
  global.webhooks = new (require('./webhooks'))()
  global.api = new (require('./api'))()
  global.twitch = new (require('./twitch'))()
  global.permissions = new (require('./permissions'))()

  global.lib = {}
  global.lib.translate = new (require('./translate'))()
  global.translate = global.lib.translate.translate

  // panel
  global.logger._panel()

  console.log(figlet.textSync('sogeBot ' + _.get(process, 'env.npm_package_version', 'x.y.z'), {
    font: 'ANSI Shadow',
    horizontalLayout: 'default',
    verticalLayout: 'default'
  }))

  global.botTMI = new TwitchJs({ token: config.settings.bot_oauth, username: config.settings.bot_username })
  global.broadcasterTMI = new TwitchJs({ token: config.settings.broadcaster_oauth, username: config.settings.broadcaster_username })

  global.status.TMI = constants.CONNECTING
  const connections = new Promise(async (resolve, reject) => {
    const connect = async (bot, broadcaster, retries) => {
      try {
        if (!await global.api.oauthValidation('bot', true)) {
          global.log.error(`Something went wrong with your bot oauth - please check your config.json`)
          bot = true // don't reconnect on oauth error
          global.log.error('Bot WON\'T connect to TMI server')
        } else if (!bot) {
          global.log.info('Bot is connecting to TMI server')
          await global.botTMI.chat.connect()
          await global.botTMI.chat.join(config.settings.broadcaster_username)
          global.log.info('Bot is connected to TMI server')
          bot = true
        }
      } catch (e) {
        global.log.info('Bot failed to connect to TMI server')
        global.log.error(e.stack)
      }

      try {
        if (_.get(config, 'settings.broadcaster_oauth', '').match(/oauth:[\w]*/)) {
          if (!await global.api.oauthValidation('broadcaster', true)) {
            global.log.error(`Something went wrong with your broadcaster oauth - please check your config.json`)
            broadcaster = true // don't reconnect on oauth error
            global.log.error('Broadcaster WON\'T connect to TMI server')
          } else if (!broadcaster) {
            global.log.info('Broadcaster is connecting to TMI server')
            await global.broadcasterTMI.chat.connect()
            await global.broadcasterTMI.chat.join(config.settings.broadcaster_username)
            global.log.info('Broadcaster is connected to TMI server')
            broadcaster = true
          }
        } else {
          global.log.error('Broadcaster oauth is not properly set - hosts will not be loaded')
          global.log.error('Broadcaster oauth is not properly set - subscribers will not be loaded')
          broadcaster = true
        }
      } catch (e) {
        global.log.info('Broadcaster failed to connect to TMI server')
        global.log.error(e.stack)
      }

      retries++
      if (retries > 15) {
        global.status.tmi = constants.DISCONNECTED
        reject(new Error('Max retries reached'))
      } else if (!bot || !broadcaster) {
        setTimeout(() => {
          global.status.TMI = constants.RECONNECTING
          connect(bot, broadcaster, retries)
        }, 1000 * retries)
      } else {
        global.status.TMI = constants.CONNECTED
        resolve()
      }
    }
    if (!global.mocha) connect(false, false, 0)
  })
  connections.then(() => {})

  global.lib.translate._load().then(function () {
    global.systems = require('auto-load')('./dest/systems/')
    global.widgets = require('auto-load')('./dest/widgets/')
    global.overlays = require('auto-load')('./dest/overlays/')
    global.games = require('auto-load')('./dest/games/')
    global.integrations = require('auto-load')('./dest/integrations/')

    global.panel.expose()
    loadClientListeners()

    if (process.env.HEAP && process.env.HEAP.toLowerCase() === 'true') {
      global.log.warning(chalk.bgRed.bold('HEAP debugging is ENABLED'))
      setTimeout(() => require('./heapdump.js').init('heap/'), 120000)
    }
  })
}

function fork () {
  let worker = cluster.fork()
  forkOn(worker)
}

function forkOn (worker) {
  if (!global.db.engine.connected || !(global.lib && global.lib.translate)) return setTimeout(() => forkOn(worker), 1000)
  // processing messages from workers
  worker.on('message', async (msg) => {
    if (msg.type === 'lang') {
      for (let worker in cluster.workers) cluster.workers[worker].send({ type: 'lang' })
      await global.lib.translate._load()
    } else if (msg.type === 'call') {
      const namespace = _.get(global, msg.ns, null)
      namespace[msg.fnc].apply(namespace, msg.args)
    } else if (msg.type === 'log') {
      return global.log[msg.level](msg.message, msg.params)
    } else if (msg.type === 'stats') {
      let avgTime = 0
      global.avgResponse.push(msg.value)
      if (msg.value > 1000) global.log.warning(`Took ${msg.value}ms to process: ${msg.message}`)
      if (global.avgResponse.length > 100) global.avgResponse.shift()
      for (let time of global.avgResponse) avgTime += parseInt(time, 10)
      global.status['RES'] = (avgTime / global.avgResponse.length).toFixed(0)
    } else if (msg.type === 'say') {
      global.commons.message('say', config.settings.broadcaster_username, msg.message)
    } else if (msg.type === 'me') {
      global.commons.message('me', config.settings.broadcaster_username, msg.message)
    } else if (msg.type === 'whisper') {
      global.commons.message('whisper', msg.sender, msg.message)
    } else if (msg.type === 'parse') {
      _.sample(cluster.workers).send({ type: 'message', sender: msg.sender, message: msg.message, skip: true, quiet: msg.quiet }) // resend to random worker
    } else if (msg.type === 'db') {
      // do nothing on db
    } else if (msg.type === 'timeout') {
      global.commons.timeout(msg.username, msg.reason, msg.timeout)
    } else if (msg.type === 'api') {
      global.api[msg.fnc](msg.username, msg.id)
    } else if (msg.type === 'event') {
      global.events.fire(msg.eventId, msg.attributes)
    }
  })
}

function loadClientListeners () {
  global.broadcasterTMI.chat.on('DISCONNECT', async (message) => {
    global.log.info('Broadcaster is disconnected from TMI server')
    global.status.tmi = constants.DISCONNECTED
  })
  global.broadcasterTMI.chat.on('RECONNECT', async (message) => {
    global.log.info('Broadcaster is reconnecting to TMI server')
    global.status.tmi = constants.RECONNECTING
  })
  global.broadcasterTMI.chat.on('CONNECTED', async (message) => {
    global.log.info('Broadcaster is connected to TMI server')
    global.status.tmi = constants.CONNECTED
  })
  global.botTMI.chat.on('DISCONNECT', async (message) => {
    global.log.info('Bot is disconnected from TMI server')
    global.status.tmi = constants.DISCONNECTED
  })
  global.botTMI.chat.on('RECONNECT', async (message) => {
    global.log.info('Bot is reconnecting to TMI server')
    global.status.tmi = constants.RECONNECTING
  })
  global.botTMI.chat.on('CONNECTED', async (message) => {
    global.log.info('Bot is connected to TMI server')
    global.status.tmi = constants.CONNECTED
  })

  global.broadcasterTMI.chat.on('PRIVMSG/HOSTED', async (message) => {
    // Someone is hosting the channel and the message contains how many viewers..
    const username = message.message.split(' ')[0].replace(':', '').toLowerCase()
    const autohost = message.message.includes('auto')
    let viewers = message.numberOfViewers || '0'

    global.log.host(`${username}, viewers: ${viewers}, autohost: ${autohost}`)
    global.db.engine.update('cache.hosts', { username }, { username })

    const data = {
      username: username,
      viewers: viewers,
      autohost: autohost,
      type: 'host'
    }

    global.overlays.eventlist.add(data)
    global.events.fire('hosted', data)
  })

  global.botTMI.chat.on('WHISPER', async (message) => {
    if (!global.commons.isBot(message.tags.displayName) || !message.isSelf) {
      message.tags.username = message.tags.displayName.toLowerCase() // backward compatibility until userID is primary key
      message.tags['message-type'] = 'whisper'
      sendMessageToWorker(message.tags, message.message)
      global.linesParsed++
    }
  })

  global.botTMI.chat.on('PRIVMSG', async (message) => {
    if (!global.commons.isBot(message.tags.displayName) || !message.isSelf) {
      message.tags.username = message.tags.displayName.toLowerCase() // backward compatibility until userID is primary key
      message.tags['message-type'] = message.message.startsWith('\u0001ACTION') ? 'action' : 'say' // backward compatibility for /me moderation

      if (message.event === 'CHEER') {
        cheer(message.tags, message.message)
      } else {
        // strip message from ACTION
        message.message = message.message.replace('\u0001ACTION ', '').replace('\u0001', '')

        sendMessageToWorker(message.tags, message.message)
        global.linesParsed++

        if (message.tags['message-type'] === 'action') global.events.fire('action', { username: message.tags.username.toLowerCase() })
      }
    }
  })

  global.botTMI.chat.on('CLEARCHAT', message => {
    if (message.event === 'USER_BANNED') {
      const duration = message.tags.banDuration
      const reason = message.tags.banReason
      const username = message.username.toLowerCase()

      if (typeof duration === 'undefined') {
        global.log.ban(`${username}, reason: ${reason}`)
        global.events.fire('ban', { username: username, reason: reason })
      } else {
        global.events.fire('timeout', { username, reason, duration })
      }
    } else {
      global.events.fire('clearchat')
    }
  })

  global.botTMI.chat.on('HOSTTARGET', message => {
    if (message.event === 'HOST_ON') {
      if (typeof message.numberOfViewers !== 'undefined') { // may occur on restart bot when hosting
        global.events.fire('hosting', { target: message.username, viewers: message.numberOfViewers })
      }
    }
  })

  global.botTMI.chat.on('MODE', async (message) => {
    const user = await global.users.getByName(message.username)
    if (!user.is.mod && message.isModerator) global.events.fire('mod', { username: message.username })
    if (!user.id) { user.id = await global.users.getIdFromTwitch(message.username) }
    global.users.set(message.username, { id: user.id, is: { mod: message.isModerator } })

    if (message.username === config.settings.bot_username) global.status.MOD = message.isModerator
  })

  global.botTMI.chat.on('USERNOTICE', message => {
    if (message.event === 'RAID') {
      global.log.raid(`${message.parameters.login}, viewers: ${message.parameters.viewerCount}`)
      global.db.engine.update('cache.raids', { username: message.parameters.login }, { username: message.parameters.login })

      const data = {
        username: message.parameters.login,
        viewers: message.parameters.viewerCount,
        type: 'raid'
      }

      global.overlays.eventlist.add(data)
      global.events.fire('raided', data)
    } else if (message.event === 'SUBSCRIPTION') {
      const method = {
        plan: message.parameters.subPlan === 'Prime' ? 1000 : message.parameters.subPlan,
        prime: message.parameters.subPlan === 'Prime' ? 'Prime' : false
      }
      subscription(message.tags.displayName.toLowerCase(), message.tags, method)
    } else if (message.event === 'RESUBSCRIPTION') {
      message.tags.username = message.tags.displayName.toLowerCase()
      const method = {
        plan: message.parameters.subPlan === 'Prime' ? 1000 : message.parameters.subPlan,
        prime: message.parameters.subPlan === 'Prime' ? 'Prime' : false
      }
      resub(message.tags.username, Number(message.parameters.months), message.message, message.tags, method)
    } else if (message.event === 'SUBSCRIPTION_GIFT') {
      subgift(message.tags.displayName.toLowerCase(), Number(message.parameters.months), message.parameters.recipientName)
    } else if (message.event === 'SUBSCRIPTION_GIFT_COMMUNITY') {
      subscriptionGiftCommunity(message.tags.displayName.toLowerCase(), Number(message.parameters.senderCount), Number(message.parameters.subPlan))
    } else if (message.event === 'RITUAL') {
      if (message.parameters.ritualName === 'new_chatter') {
        global.db.engine.increment('api.new', { key: 'chatters' }, { value: 1 })
      } else {
        global.log.info('Unknown RITUAL')
      }
    } else {
      global.log.info('Unknown USERNOTICE')
      global.log.info(JSON.stringify(message))
    }
  })

  global.botTMI.chat.on('NOTICE', message => {
    global.log.info(message.message)
  })
}

if (cluster.isMaster) {
  process.on('unhandledRejection', function (reason, p) {
    global.log.error(`Possibly Unhandled Rejection at: ${util.inspect(p)} reason: ${reason}`)
  })

  process.on('uncaughtException', (error) => {
    if (_.isNil(global.log)) return console.log(error)
    global.log.error(util.inspect(error))
    global.log.error('+------------------------------------------------------------------------------+')
    global.log.error('| BOT HAS UNEXPECTEDLY CRASHED                                                 |')
    global.log.error('| PLEASE CHECK https://github.com/sogehige/SogeBot/wiki/How-to-report-an-issue |')
    global.log.error('| AND ADD logs/exceptions.log file to your report                              |')
    global.log.error('+------------------------------------------------------------------------------+')
    process.exit(1)
  })
}

async function subscription (username, userstate, method) {
  if (global.commons.isIgnored(username)) return

  const user = await global.db.engine.findOne('users', { id: userstate.userId })
  let subscribedAt = _.now()
  let isSubscriber = true

  if (user.lock && user.lock.subcribed_at) subscribedAt = undefined
  if (user.lock && user.lock.subscriber) isSubscriber = undefined

  global.users.setById(userstate.userId, { username, is: { subscriber: isSubscriber }, time: { subscribed_at: subscribedAt }, stats: { tier: method.prime ? 'Prime' : method.plan / 1000 } })
  global.overlays.eventlist.add({ type: 'sub', tier: (method.prime ? 'Prime' : method.plan / 1000), username: username, method: (!_.isNil(method.prime) && method.prime) ? 'Twitch Prime' : '' })
  global.log.sub(`${username}, tier: ${method.prime ? 'Prime' : method.plan / 1000}`)
  global.events.fire('subscription', { username: username, method: (!_.isNil(method.prime) && method.prime) ? 'Twitch Prime' : '' })
}

async function resub (username, months, message, userstate, method) {
  if (global.commons.isIgnored(username)) return

  const user = await global.db.engine.findOne('users', { id: userstate.userId })
  let subscribedAt = Number(moment().subtract(months, 'months').format('X')) * 1000
  let isSubscriber = true

  if (user.lock && user.lock.subcribed_at) subscribedAt = undefined
  if (user.lock && user.lock.subscriber) isSubscriber = undefined

  global.users.setById(userstate.userId, { username, id: userstate.userId, is: { subscriber: isSubscriber }, time: { subscribed_at: subscribedAt }, stats: { tier: method.prime ? 'Prime' : method.plan / 1000 } })
  global.overlays.eventlist.add({ type: 'resub', tier: (method.prime ? 'Prime' : method.plan / 1000), username: username, monthsName: global.commons.getLocalizedName(months, 'core.months'), months: months, message: message })
  global.log.resub(`${username}, months: ${months}, message: ${message}, tier: ${method.prime ? 'Prime' : method.plan / 1000}`)
  global.events.fire('resub', { username: username, monthsName: global.commons.getLocalizedName(months, 'core.months'), months: months, message: message })
}

async function subscriptionGiftCommunity (username, count, plan) {
  ignoreGiftsFromUser[username] = { count, time: new Date() }

  if (global.commons.isIgnored(username)) return

  global.overlays.eventlist.add({ type: 'subcommunitygift', username, count })
  global.events.fire('subcommunitygift', { username, count })
  global.log.subcommunitygift(`${username}, to ${count} viewers`)
}

async function subgift (username, months, recipient) {
  recipient = recipient.toLowerCase()
  for (let [u, o] of Object.entries(ignoreGiftsFromUser)) {
    // $FlowFixMe Incorrect mixed type from value of Object.entries https://github.com/facebook/flow/issues/5838
    if (o.count === 0 || new Date().getTime() - new Date(o.time).getTime() >= 1000 * 60 * 10) {
      delete ignoreGiftsFromUser[u]
    }
  }

  if (typeof ignoreGiftsFromUser[username] !== 'undefined' && ignoreGiftsFromUser[username].count !== 0) {
    ignoreGiftsFromUser[username].count--
  } else {
    global.events.fire('subgift', { username: username, recipient: recipient })
  }
  if (global.commons.isIgnored(username)) return

  let user = await global.db.engine.findOne('users', { username: recipient })
  if (!user.id) {
    user.id = await global.users.getIdFromTwitch(recipient)
  }

  if (user.id !== null) {
    let subscribedAt = _.now()
    let isSubscriber = true

    if (user.lock && user.lock.subcribed_at) subscribedAt = undefined
    if (user.lock && user.lock.subscriber) isSubscriber = undefined

    global.users.setById(user.id, { username: recipient, is: { subscriber: isSubscriber }, time: { subscribed_at: subscribedAt } })
    global.overlays.eventlist.add({ type: 'subgift', username: recipient, from: username, monthsName: global.commons.getLocalizedName(months, 'core.months'), months })
    global.log.subgift(`${recipient}, from: ${username}, months: ${months}`)
  }
}

async function cheer (userstate, message) {
  // remove cheerX or channelCheerX from message
  message = message.replace(/(.*?[cC]heer[\d]+)/g, '').trim()

  if (global.commons.isIgnored(userstate.username)) return

  global.overlays.eventlist.add({ type: 'cheer', username: userstate.username.toLowerCase(), bits: userstate.bits, message: message })
  global.log.cheer(`${userstate.username.toLowerCase()}, bits: ${userstate.bits}, message: ${message}`)
  global.db.engine.insert('users.bits', { id: await global.users.getIdByName(userstate.username.toLowerCase()), amount: userstate.bits, message: message, timestamp: _.now() })
  global.events.fire('cheer', { username: userstate.username.toLowerCase(), bits: userstate.bits, message: message })
  if (await global.cache.isOnline()) await global.db.engine.increment('api.current', { key: 'bits' }, { value: parseInt(userstate.bits, 10) })
}

let lastWorker = null
let timeouts = {}
function sendMessageToWorker (sender, message) {
  clearTimeout(timeouts['sendMessageToWorker'])
  let worker = _.sample(cluster.workers)

  if (worker.id === lastWorker && global.cpu > 1) {
    timeouts['sendMessageToWorker'] = setTimeout(() => sendMessageToWorker(sender, message), 100)
    return
  } else lastWorker = worker.id

  if (worker.isConnected()) worker.send({ type: 'message', sender: sender, message: message })
  else timeouts['sendMessageToWorker'] = setTimeout(() => sendMessageToWorker(sender, message), 100)
}

if (cluster.isMaster) {
  setInterval(() => {
    if (global.cpu > 1) { // refresh if there is more than one worker
      let worker = _.sample(cluster.workers)
      worker.send({ type: 'shutdown' })
      worker.disconnect()
    }
  }, 1000 * 60 * 60 * 2) // every 2 hour spin up new worker and kill old
}
