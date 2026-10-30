import BasePlugin from './base-plugin.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export default class AfterSeedLayer extends BasePlugin {
  static get description() {
    return (
      'The <code>AfterSeedLayer</code> plugin sets the layer of the current weekday as next ' +
      'layer once a seed layer reaches a player count, and clears it again so the vote takes ' +
      'over if the seed round gets too full.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      setThreshold: {
        required: false,
        description: 'Player count (inclusive) at which the after-seed layer is set.',
        default: 50
      },
      clearThreshold: {
        required: false,
        description: 'Player count above which the next layer is cleared so the vote takes over. 0 disables clearing.',
        default: 80
      },
      layers: {
        required: false,
        description: 'Arguments for AdminSetNextLayer per weekday (server time).',
        default: {
          monday: 'Harju_AAS_v2 BAF RGF+support',
          tuesday: 'Chora_RAAS_v1 USA PLA',
          wednesday: 'Narva_RAAS_v1 CAF+support IMF',
          thursday: 'Harju_AAS_v3 RGF PLA',
          friday: 'Mutaha_RAAS_v2 IMF USMC+support',
          saturday: 'AlBasrah_AAS_v3_CL VDV+support BAF+support',
          sunday: 'BlackCoast_AAS_v1 AFU ADF'
        }
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    // 'idle' -> 'setting' -> 'set' (layer set by us) -> 'done' (cleared or round over); reset on NEW_GAME.
    this.state = 'idle';

    this.onServerInformation = this.onServerInformation.bind(this);
    this.onNewGame = this.onNewGame.bind(this);
    this.onRoundEnded = this.onRoundEnded.bind(this);
  }

  async mount() {
    this.server.on('UPDATED_SERVER_INFORMATION', this.onServerInformation);
    this.server.on('NEW_GAME', this.onNewGame);
    this.server.on('ROUND_ENDED', this.onRoundEnded);
  }

  async unmount() {
    this.server.removeListener('UPDATED_SERVER_INFORMATION', this.onServerInformation);
    this.server.removeListener('NEW_GAME', this.onNewGame);
    this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
  }

  onNewGame() {
    this.state = 'idle';
  }

  onRoundEnded() {
    this.state = 'done';
  }

  async onServerInformation(info) {
    if (this.state === 'done' || this.server.currentLayer?.gamemode !== 'Seed') return;

    const players = info.playerCount;
    const ceiling = this.options.clearThreshold || Infinity;

    try {
      if (this.state === 'set' && players > ceiling) {
        this.state = 'done';
        // Only undo our own layer: an admin or a vote plugin may have set another one since,
        // possibly the same layer with other factions or units.
        if ((await this.server.rcon.execute('ShowNextMap')) !== this.ownNextMap) {
          this.verbose(1, 'Next layer was changed since we set it, not clearing.');
          return;
        }
        this.verbose(1, `${players} players, clearing next layer.`);
        await this.server.rcon.execute('AdminClearNextLayer');
        await this.server.updateLayerInformation();
        if (this.server.nextLayerToBeVoted !== true)
          this.verbose(1, 'Next layer is still set after AdminClearNextLayer.');
      } else if (
        this.state === 'idle' &&
        players >= this.options.setThreshold &&
        players <= ceiling &&
        this.server.nextLayerToBeVoted === true
      ) {
        const layer = this.options.layers[WEEKDAYS[new Date().getDay()]];
        if (!layer) return;

        // The cached vote state can be 30s old, so re-check it right before setting.
        // 'setting' also blocks overlapping events; a failed set stays there until NEW_GAME.
        this.state = 'setting';
        const next = await this.server.rcon
          .getNextMap()
          .catch((err) => this.verbose(1, 'Failed to read next layer.', err));
        // ROUND_ENDED or NEW_GAME may have fired while waiting for RCON.
        if (this.state !== 'setting') return;
        if (!next?.toBeVoted) {
          this.state = 'idle';
          return;
        }
        await this.server.rcon.execute(`AdminSetNextLayer ${layer}`);
        // Squad's own answer covers layer and factions, however the config spells them.
        this.ownNextMap = await this.server.rcon.execute('ShowNextMap');
        this.verbose(1, `${players} players, set next layer ${layer}, ShowNextMap: ${this.ownNextMap}`);
        if (this.state !== 'setting') return;
        this.state = 'set';
        await this.server.updateLayerInformation();
      }
    } catch (err) {
      this.verbose(1, 'Failed to update next layer.', err);
    }
  }
}
