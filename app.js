'use strict';

const Homey = require('homey');
const { HomeyAPI } = require("homey-api");
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyApp has been initialized');
    this._api = await HomeyAPI.createAppAPI({
      homey: this.homey,
      debug: false
    });
    if (!this.homey.settings.get('isFirstRun')) {
      await this.initFlowRevisions();
      this.homey.settings.set('isFirstRun',true);
    }
    await this._api.flow.connect();
    this._api.flow.on('flow.create', async flow => await this.onFlowUpdate(flow,false));
    this._api.flow.on('advancedflow.create', async flow => await this.onFlowUpdate(flow,true));
    this._api.flow.on('flow.update', async flow => await this.onFlowUpdate(flow,false));
    this._api.flow.on('advancedflow.update', async flow => await this.onFlowUpdate(flow,true));
  }

  async getFlowRevisions(flowId) {
    return (await this.homey.settings.get(`flow_revisions_${flowId}`)) ?? [];
  }

  async getHomeyBaseUrl() {
    const homeyId = await this.homey.cloud.getHomeyId();
    return `https://${homeyId}.connect.athom.com`;
  }

  async initFlowRevisions() {
    const [flows, advancedFlows] = await Promise.all([
      this._api.flow.getFlows(),
      this._api.flow.getAdvancedFlows(),
    ]);

    for (const flow of Object.values(flows)) {
      await this.initRevision(flow, false);
    }
    for (const flow of Object.values(advancedFlows)) {
      await this.initRevision(flow, true);
    }
  }

  formatFlow(flow, isAdvanced) {
    if (isAdvanced) {
      return {
        type: 'advanced',
        name: flow.name,
        cards: flow.cards,
      };
    }
    return {
      type: 'standard',
      name: flow.name,
      trigger: flow.trigger,
      conditions: flow.conditions,
      actions: flow.actions,
    };
  }

  async initRevision(flow, isAdvanced) {
    const key = `flow_revisions_${flow.id}`;
    const existing = await this.homey.settings.get(key);
    if (existing !== null) return;

    const filename = uuidv4() + '.json';
    await fs.writeFile(path.join('/userdata', filename), JSON.stringify(this.formatFlow(flow, isAdvanced)), 'utf8');
    await this.homey.settings.set(key, [{
      timestamp: new Date().toISOString(),
      filename,
      name: flow.name,
      isAdvanced,
    }]);
  }

  async onFlowUpdate(flow, isAdvanced = false) {
    const key = `flow_revisions_${flow.id}`;
    const revisions = (await this.homey.settings.get(key)) ?? [];

    const filename = uuidv4() + '.json';
    await fs.writeFile(path.join('/userdata', filename), JSON.stringify(this.formatFlow(flow, isAdvanced)), 'utf8');

    revisions.unshift({
      timestamp: new Date().toISOString(),
      filename,
      name: flow.name,
      isAdvanced,
    });

    if (revisions.length > 5) {
      const dropped = revisions.pop();
      try { await fs.unlink(path.join('/userdata', dropped.filename)); } catch (e) {}
    }

    await this.homey.settings.set(key, revisions);
  }

};
