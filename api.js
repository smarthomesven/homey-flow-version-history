module.exports = {
  async homeyBaseUrl({ homey }) {
    const homeyId = await homey.cloud.getHomeyId();
    return `https://${homeyId}.connect.athom.com`;
  }
};