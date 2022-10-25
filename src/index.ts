import fastify from "fastify";
import FastifyPostgres from "@fastify/postgres";
import * as yup from "yup";

const server = fastify();
server.register(FastifyPostgres, {
  connectionString: process.env.DATABASE_URL,
});

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
      .filter(({ Group: { deployment }}) => deployment)
      .map(({ Group: { deployment }, Result }) => ({ deployment, value: Result }));

    console.log("Writing items to DB", {
      count: items.length,
      hookKey,
    });
    await server.pg.transact(async (client) => {
      await Promise.all(
        items.map(({ deployment, value }) =>
          client.query(
            "INSERT INTO honeycomb_triggers (hook, deployment, value) VALUES ($1, $2, $3)",
            [hookKey, deployment, value]
          )
        )
      );
    });
    console.log('Done writing');

    return "gotcha";
  } catch (err) {
    console.error(err);
    throw err;
  }
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;

server.listen({ port }, async (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  const client = await server.pg.connect();
  try {
    console.log('Creating schema');
    await client.query(`CREATE TABLE IF NOT EXISTS honeycomb_triggers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      hook text NOT NULL,
      deployment text NOT NULL,
      value integer NOT NULL,

      UNIQUE (hook, deployment, timestamp)
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS honeycomb_triggers_hook ON honeycomb_triggers (hook)`);
    await client.query(`CREATE INDEX IF NOT EXISTS honeycomb_triggers_deployment ON honeycomb_triggers (deployment)`);
  } catch (err) {
    console.error(err);
    throw err;
  } finally {
    client.release();
  }

  console.log(`Server listening at ${address}`);
});
