import type {
  DecoratorContext,
  Interface,
  Model,
  Namespace,
  Operation,
  Type,
} from "@typespec/compiler";
import { addExtension, toPlainValue } from "tsp-asyncapi-core";
import { checkProfile, EXTENSION_KEY } from "./profile.js";
import { problem, read, write } from "./state.js";
import type {
  ChannelProfile,
  InfoProfile,
  MessageProfile,
  OperationProfile,
  ServiceBusProfile,
} from "./types.js";

function record(
  context: DecoratorContext,
  target: Type,
  expected: ServiceBusProfile["target"],
  config: ServiceBusProfile,
): void {
  const existing = read(context.program, target);
  if (existing !== undefined) {
    if (existing.application === context.decoratorTarget) return;
    problem(
      context.program,
      target,
      "profile-conflict",
      "Only one composite profile is allowed per target.",
    );
    return;
  }
  const source = context.getArgumentTarget(0) ?? target;
  const profile = checkProfile(
    context.program,
    source,
    expected,
    toPlainValue(context.program, config),
  );
  if (profile === undefined) return;
  write(context.program, target, { profile, source, application: context.decoratorTarget });
  addExtension(context, target, EXTENSION_KEY, profile, { keyTarget: source, valueTarget: source });
}

export function $infoProfile(
  context: DecoratorContext,
  target: Namespace,
  config: InfoProfile,
): void {
  record(context, target, "info", config);
}
export function $channelProfile(
  context: DecoratorContext,
  target: Interface | Namespace,
  config: ChannelProfile,
): void {
  record(context, target, "channel", config);
}
export function $messageProfile(
  context: DecoratorContext,
  target: Model,
  config: MessageProfile,
): void {
  record(context, target, "message", config);
}
export function $operationProfile(
  context: DecoratorContext,
  target: Operation,
  config: OperationProfile,
): void {
  record(context, target, "operation", config);
}
