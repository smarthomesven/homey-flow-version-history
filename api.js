module.exports = {
  async homeyBaseUrl({ homey }) {
    const homeyId = await homey.cloud.getHomeyId();
    return `https://${homeyId}.connect.athom.com`;
  },

  async setMaxRevisions({ homey, body }) {
    return homey.app.setMaxRevisions(body.max);
  },
  async purgeTrash({ homey }) {
    try {
      await homey.app.purgeTrash();
      return { success: true };
    } catch (e) {
      throw new Error(e.message || 'purgeTrash failed');
    }
  },

  async purgeRevisions({ homey }) {
    try {
      await homey.app.purgeRevisions();
      return { success: true };
    } catch (e) {
      throw new Error(e.message || 'purgeRevisions failed');
    }
  },
};