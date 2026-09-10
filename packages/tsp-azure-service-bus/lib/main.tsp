import "tsp-asyncapi-core";
import "./models.tsp";
import "../dist/src/tsp-index.js";

using TypeSpec.Reflection;

namespace Azure.ServiceBus;

/**
 * Declares one complete profile on a service namespace, emitted on AsyncAPI info.
 * @param target The service namespace, not also a profiled channel.
 * @param config The explicit profile envelope and info requirements.
 */
extern dec infoProfile(target: Namespace, config: valueof InfoProfile);

/**
 * Declares one complete profile on an existing AsyncAPI channel.
 * @param target An interface or namespace marked @channel or @dynamicChannel.
 * @param config The explicit profile envelope, logical entity and requirements.
 */
extern dec channelProfile(target: Interface | Namespace, config: valueof ChannelProfile);

/**
 * Declares one complete profile on an existing AsyncAPI @message model.
 * @param target The marked message model, not its payload properties.
 * @param config The explicit profile envelope and native message requirements.
 */
extern dec messageProfile(target: Model, config: valueof MessageProfile);

/**
 * Declares one complete profile on an existing AsyncAPI @send or @receive operation.
 * @param target The operation whose standard action must match config.action.
 * @param config The explicit profile envelope, action and application obligations.
 */
extern dec operationProfile(target: Operation, config: valueof OperationProfile);
