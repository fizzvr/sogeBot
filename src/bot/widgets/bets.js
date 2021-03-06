'use strict'

const _ = require('lodash')

class BetsWidget {
  constructor () {
    this.timeouts = {}

    this.modifiedAt = 0
    this.currentBet = {}
    this.bets = []

    if (require('cluster').isWorker) return

    global.panel.addWidget('bets', 'widget-title-bets', 'far fa-money-bill-alt')

    this.sockets()
    this.interval()
  }

  async interval () {
    clearTimeout(this.timeouts['betsWidgetsInterval'])
    try {
      let _modifiedAt = await global.db.engine.findOne('systems.bets', { key: 'betsModifiedTime' })
      if (this.modifiedAt !== _modifiedAt) {
        this.modifiedAt = _modifiedAt
        this.currentBet = await global.db.engine.findOne('systems.bets', { key: 'bets' })
        this.bets = await global.db.engine.find('systems.bets.users')
      }
    } catch (e) {
      global.log.error(e.stack)
    } finally {
      this.timeouts['betsWidgetsInterval'] = setTimeout(() => this.interval(), 1000)
    }
  }

  sockets () {
    global.panel.io.of('/widgets/bets').on('connection', (socket) => {
      socket.on('data', async (callback) => {
        callback(this.currentBet, this.bets)
      })

      socket.on('settings.update', async (data, cb) => {
        global.systems.bets.settings.betPercentGain = data.betPercentGain
        cb(null)
      })

      socket.on('settings', async (cb) => {
        cb(null, { betPercentGain: await global.systems.bets.settings.betPercentGain })
      })

      socket.on('close', async (option) => {
        const message = '!bet ' + (option === 'refund' ? option : 'close ' + option)
        global.log.process({ type: 'parse', sender: { username: global.commons.getOwner() }, message: message })
        _.sample(require('cluster').workers).send({ type: 'message', sender: { username: global.commons.getOwner() }, message: message, skip: true })
      })
    })
  }
}

module.exports = new BetsWidget()
