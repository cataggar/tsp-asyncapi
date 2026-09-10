import { $channelProfile, $infoProfile, $messageProfile, $operationProfile } from "./decorators.js";

export { $lib } from "./lib.js";
export { $onValidate } from "./validate.js";

export const $decorators = {
  "Azure.ServiceBus": {
    infoProfile: $infoProfile,
    channelProfile: $channelProfile,
    messageProfile: $messageProfile,
    operationProfile: $operationProfile,
  },
};
