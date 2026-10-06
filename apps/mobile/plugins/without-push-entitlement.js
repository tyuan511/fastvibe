const { withEntitlementsPlist } = require("expo/config-plugins");

/**
 * Drop the `aps-environment` entitlement that expo-notifications adds to every iOS build.
 *
 * The app posts local notifications only and never asks for a push token. Leaving the
 * entitlement in makes the App ID need the Push Notifications capability, which
 * automatic signing then has to enable on the account, and makes an App Store build
 * claim a capability it does not use.
 *
 * Mods run in the reverse of registration order, so this plugin is listed *before*
 * expo-notifications in app.json: that is what makes it run after the entitlement exists.
 */
module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    delete modConfig.modResults["aps-environment"];
    return modConfig;
  });
};
