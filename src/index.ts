import AWS from "aws-sdk";
import type { PutItemInputAttributeMap } from "aws-sdk/clients/dynamodb";
import fastify from "fastify";
import * as yup from "yup";

const dyndb = new AWS.DynamoDB({ apiVersion: "2012-08-10", region: 'ap-southeast-2' });

function writeItems(table: string, items: PutItemInputAttributeMap[]) {
  return new Promise((resolve, reject) => {
    dyndb.batchWriteItem({
      RequestItems: {
        [table]: items.map((Item) => ({
          PutRequest: { Item },
        })),
      },
    }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

const server = fastify();

server.get("/", async (request, reply) => {
  return "pong";
});

const HOOK_SCHEMA = yup.object({
  version: yup.string().required().oneOf(["v0.1.0"]),
  shared_secret: yup.string().optional(),
  name: yup.string().required(),
  trigger_description: yup
    .string()
    .required()
    .matches(/^status:[a-z0-9-]+$/),
  result_url: yup.string().url().required(),
  result_groups: yup
    .array()
    .of(
      yup.object({
        Group: yup.object().required(),
        Result: yup.number().required(),
      })
    )
    .required(),
});

const HOOK_SECRET = process.env.HONEYCOMB_HOOK_SECRET;
const HOOK_TABLE = process.env.STATUS_HOOK_TABLE ?? 'tamanu-status-dev';
server.post("/hook/honeycomb", async (request, reply) => {
  try {
    const hook = await HOOK_SCHEMA.validate(request.body);

    if (!HOOK_SECRET) {
      console.warn("Accepting ALL hooks regardless of secret!");
    } else if (!hook.shared_secret) {
      console.warn("No shared secret on hook!");
    } else if (HOOK_SECRET !== hook.shared_secret) {
      throw new Error("Invalid shared secret");
    }

    const hookKey = hook.trigger_description.split(":", 2)[1];
    const items = hook.result_groups
      .map(({ Group: { deployment }, Result }) => ({
        Hook: { S: hookKey},
        Deployment: { S: deployment },
        Value: { N: Result.toString() },
      }))
      .filter((item) => item.Deployment);

    console.log('Writing items to DynamoDB', { count: items.length, hookKey, table: HOOK_TABLE });
    await writeItems(HOOK_TABLE, items);

    return "gotcha";
  } catch (err) {
    console.error(err);
    throw err;
  }
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;

server.listen({ port }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  console.log(`Server listening at ${address}`);
});
