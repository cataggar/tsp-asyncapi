import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { Ajv } from "ajv";
import { EXTENSION_KEY } from "tsp-azure-service-bus";
import type { ChannelProfile, OperationProfile } from "tsp-azure-service-bus/types";
import type { AsyncAPIDocument } from "#emitter/types/index.js";
import { channelsOf, messagesOf, operationsOf, serversOf } from "../utils/document.js";
import { referencesIn } from "../utils/references.js";
import { resolveRef } from "../utils/json-pointer.js";
import { validateOpenAPI31Document } from "../utils/openapi-validation.js";
import { emitOpenAPI31 } from "../utils/openapi-emitter.js";
import {
  assertInteroperabilityOutputSet,
  generateInteroperability,
  INTEROPERABILITY_OUTPUTS,
  INTEROPERABILITY_ROOT,
} from "../utils/interoperability-generation.js";

function text(file: string): string {
  return readFileSync(join(INTEROPERABILITY_ROOT, file), "utf8");
}

function asyncDocument(file: string): AsyncAPIDocument {
  return JSON.parse(text(file)) as AsyncAPIDocument;
}

const GATEWAY = asyncDocument("asyncapi.json");
const PROCESSOR = asyncDocument("processor/asyncapi.json");
const FULFILLMENT = asyncDocument("fulfillment/asyncapi.json");
const APPLICATIONS = [
  ["gateway", GATEWAY, ["submitOrder", "receiveResult"], ["PlaceOrder", "OrderCommandResult"]],
  [
    "processor",
    PROCESSOR,
    ["processOrder", "sendResult", "publishOrderPlaced"],
    ["PlaceOrder", "OrderCommandResult", "OrderPlaced"],
  ],
  ["fulfillment", FULFILLMENT, ["onOrderPlaced"], ["OrderPlaced"]],
] as const;
const profileSchema: object = JSON.parse(
  readFileSync(
    new URL("../../docs/public/profiles/azure-service-bus/0.1.0/schema.json", import.meta.url),
    "utf8",
  ),
) as object;
const validateProfile = new Ajv({
  strict: false,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
}).compile(profileSchema);

describe("Public HTTP and Service Bus example: generation", () => {
  it("rejects missing and extra artifacts, including nested and alternative YAML filenames", () => {
    expect(() => {
      assertInteroperabilityOutputSet([
        ...INTEROPERABILITY_OUTPUTS,
        "fixtures/flow.json",
        "http/tspconfig.yaml",
      ]);
    }).not.toThrow();
    expect(() => {
      assertInteroperabilityOutputSet(INTEROPERABILITY_OUTPUTS.slice(1));
    }).toThrow("Missing generated documents: asyncapi.yaml");
    for (const extra of [
      "asyncapi.old.json",
      "processor/stale/asyncapi.json",
      "http/openapi.yml",
    ]) {
      expect(() => {
        assertInteroperabilityOutputSet([...INTEROPERABILITY_OUTPUTS, extra]);
      }).toThrow(`Unexpected generated documents: ${extra}`);
    }
  });

  it("regenerates exactly the eight committed documents byte-for-byte", async () => {
    await generateInteroperability(true);
    expect(INTEROPERABILITY_OUTPUTS).toHaveLength(8);
  });

  it.each(["", "processor/", "fulfillment/", "http/"])(
    "keeps both serializations equivalent for %s",
    (directory) => {
      const name = directory === "http/" ? "openapi" : "asyncapi";
      expect(parse(text(`${directory}${name}.yaml`))).toStrictEqual(
        JSON.parse(text(`${directory}${name}.json`)),
      );
    },
  );

  it("also compiles the unmodified HTTP import graph through the reusable tester", async () => {
    const emitted = await emitOpenAPI31({
      "main.tsp": 'import "./http/main.tsp";',
      "http/main.tsp": text("http/main.tsp"),
      "domain/order.tsp": text("domain/order.tsp"),
      "environments/public.tsp": text("environments/public.tsp"),
    });
    expect(emitted.document).toStrictEqual(JSON.parse(text("http/openapi.json")));
  });
});

describe("Public HTTP and Service Bus example: contract structure", () => {
  it.each(INTEROPERABILITY_OUTPUTS)(
    "validates %s and resolves every local reference",
    async (file) => {
      const document: unknown = parse(text(file));
      if (file.startsWith("http/")) expect(validateOpenAPI31Document(document)).toBeNull();
      else await expect(document).toBeValidAsyncAPI();
      const references = referencesIn(document);
      expect(references.length).toBeGreaterThan(0);
      for (const ref of references) {
        expect(ref).toMatch(/^#\//);
        expect(resolveRef(document, ref), ref).not.toBeUndefined();
      }
    },
  );

  it.each(APPLICATIONS)(
    "isolates %s and validates every profiled participant",
    (_name, document, operations, messages) => {
      expect(document.asyncapi).toBe("3.1.0");
      expect(Object.keys(operationsOf(document))).toEqual(operations);
      expect(Object.keys(messagesOf(document))).toEqual(messages);
      const participants = [
        ["info", document.info],
        ...Object.values(channelsOf(document)).map((value) => ["channel", value] as const),
        ...Object.values(messagesOf(document)).map((value) => ["message", value] as const),
        ...Object.values(operationsOf(document)).map((value) => ["operation", value] as const),
      ] as const;
      for (const [target, participant] of participants) {
        const profile = (participant as Record<string, unknown>)[EXTENSION_KEY];
        expect(validateProfile(profile), JSON.stringify(validateProfile.errors)).toBe(true);
        expect(profile).toHaveProperty("target", target);
      }
      for (const operation of Object.values(operationsOf(document))) {
        const profile = operation[EXTENSION_KEY] as OperationProfile;
        expect(profile.action).toBe(operation.action);
        expect(profile.authorizationRequirements).toEqual({ tls: true, authentication: "entraId" });
        expect(operation.bindings).toBeUndefined();
        if (operation.action === "receive") {
          expect(profile.deliveryRequirements).toEqual({
            receiveMode: "peekLock",
            order: "perSession",
          });
          expect(profile.applicationObligations).toMatchObject({
            idempotency: "required",
            settlement: "completeAfterSuccess",
            lockLoss: "treatAsUnsettled",
            sessionProcessing: "serial",
            failureHandling: "abandonTransientDeadLetterPermanent",
            expiry: "checkApplicationDeadline",
            deadLetter: "inspectAndRemediate",
          });
        } else {
          expect(profile.applicationObligations?.messageIdentity).toBe(
            "uniquePerMessageStableOnRetry",
          );
          expect(profile.deliveryRequirements).toBeUndefined();
        }
      }
      for (const channel of Object.values(channelsOf(document))) {
        const profile = channel[EXTENSION_KEY] as ChannelProfile;
        expect(channel.bindings).toBeUndefined();
        expect(profile.deploymentRequirements).toMatchObject({
          allowedTiers: ["standard", "premium"],
          defaultTtlSeconds: 86400,
        });
        if (profile.entity.kind !== "topic") {
          expect(profile.deploymentRequirements).toMatchObject({
            sessions: true,
            lockDurationSeconds: 30,
            maxDeliveryCount: 10,
            deadLetterOnExpiration: true,
          });
        }
        if (profile.entity.kind !== "subscription") {
          expect(profile.deploymentRequirements).toMatchObject({
            partitioning: "disabled",
            duplicateDetection: { required: true, scope: "messageId", historyWindowSeconds: 600 },
          });
        }
      }
      for (const message of Object.values(messagesOf(document))) {
        expect(message.correlationId).toBeUndefined();
        expect(message.contentType).toBe("application/json");
        expect(message.bindings).toBeUndefined();
      }
      expect(serversOf(document)["service-bus"]).toMatchObject({
        host: "servicebus.example.invalid",
        protocol: "amqps",
        protocolVersion: "1.0",
      });
      expect(serversOf(document)["service-bus"].security).toBeUndefined();
    },
  );

  it("models the command and result from inverse application perspectives", () => {
    const send = operationsOf(GATEWAY).submitOrder;
    const receive = operationsOf(PROCESSOR).processOrder;
    expect(send.action).toBe("send");
    expect(receive.action).toBe("receive");
    for (const operation of [send, receive]) {
      expect(operation.messages).toEqual([{ $ref: "#/channels/commands/messages/PlaceOrder" }]);
      expect(operation.reply).toEqual({
        channel: { $ref: "#/channels/replies" },
        messages: [{ $ref: "#/channels/replies/messages/OrderCommandResult" }],
      });
      expect(operation[EXTENSION_KEY]).toHaveProperty("nativeReply", {
        address: "fixedChannel",
        correlation: "requestMessageId",
        session: "requestReplyToSessionId",
      });
    }
    expect(operationsOf(GATEWAY).receiveResult.action).toBe("receive");
    expect(operationsOf(PROCESSOR).sendResult.action).toBe("send");
    for (const name of ["commands", "replies"]) {
      expect(channelsOf(GATEWAY)[name]).toEqual(channelsOf(PROCESSOR)[name]);
    }
  });

  it("publishes only to the topic and receives from its session-enabled subscription", () => {
    const topic = channelsOf(PROCESSOR).events;
    const subscription = channelsOf(FULFILLMENT).fulfillment;
    const topicProfile = topic[EXTENSION_KEY] as ChannelProfile;
    const subscriptionProfile = subscription[EXTENSION_KEY] as ChannelProfile;
    expect(topicProfile.entity).toEqual({ kind: "topic", id: "orders.events" });
    expect(subscriptionProfile.entity).toEqual({
      kind: "subscription",
      id: "orders.fulfillment",
      topicId: "orders.events",
    });
    expect(topicProfile.deploymentRequirements?.sessions).toBeUndefined();
    expect(subscriptionProfile.deploymentRequirements?.sessions).toBe(true);
    expect(operationsOf(PROCESSOR).publishOrderPlaced).toMatchObject({
      action: "send",
      channel: { $ref: "#/channels/events" },
    });
    expect(operationsOf(FULFILLMENT).onOrderPlaced).toMatchObject({
      action: "receive",
      channel: { $ref: "#/channels/fulfillment" },
    });
    expect(Object.keys(channelsOf(FULFILLMENT))).toEqual(["fulfillment"]);
  });

  it("does not confuse profile schema validation with cross-object conformance", () => {
    const invalid = structuredClone(channelsOf(PROCESSOR).events[EXTENSION_KEY]) as ChannelProfile;
    const mutated = {
      ...invalid,
      deploymentRequirements: { ...invalid.deploymentRequirements, sessions: true },
    };
    expect(validateProfile(mutated)).toBe(false);
    expect(validateProfile.errors?.length).toBeGreaterThan(0);
  });
});

describe("Public HTTP and Service Bus example: bilingual documentation", () => {
  it.each(["docs/guide/http-service-bus.md", "docs/zh-tw/guide/http-service-bus.md"])(
    "quotes shared source faithfully in %s",
    (file) => {
      const page = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      const blocks = [...page.matchAll(/```typespec\n([\s\S]*?)\n```/g)];
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) expect(text("domain/order.tsp")).toContain(block[1]);
      expect(page).toContain("pnpm examples:interop:check");
      expect(page).toContain("1.16.0");
      expect(page).toContain("0.86.0");
    },
  );
});
