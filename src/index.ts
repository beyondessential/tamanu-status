import fastify from "fastify";
import FastifyPostgres from "@fastify/postgres";
import FastifyView from "@fastify/view";
import ejs from "ejs";
import * as yup from "yup";
import type { QueryResult } from "pg";

const server = fastify();
server.register(FastifyPostgres, {
  connectionString: process.env.DATABASE_URL,
});

server.register(FastifyView, {
  engine: {
    ejs,
  },
});

server.get("/", async (request, reply) => {
  const data = new Map();

  const deploymentsQ: QueryResult = await server.pg.query(
    "SELECT DISTINCT deployment FROM honeycomb_triggers WHERE deployment IS NOT NULL"
  );
  const deployments: string[] = deploymentsQ.rows.map((row) => row.deployment);

  for (const deployment of deployments) {
    const depData = new Map();

    const facilitiesQ: QueryResult = await server.pg.query(
      `SELECT DISTINCT facility FROM honeycomb_triggers WHERE deployment = $1`,
      [deployment]
    );
    const facilities: (string | null)[] = facilitiesQ.rows.map(
      (row) => row.facility
    );

    for (const facility of facilities) {
      const facData = new Map();

      const hooksQ: QueryResult = await (facility
        ? server.pg.query(
            `SELECT DISTINCT hook FROM honeycomb_triggers WHERE deployment = $1 AND facility = $2`,
            [deployment, facility]
          )
        : server.pg.query(
            `SELECT DISTINCT hook FROM honeycomb_triggers WHERE deployment = $1 AND facility IS NULL`,
            [deployment]
          ));
      const hooks: string[] = hooksQ.rows.map((row) => row.hook);

      for (const hook of hooks) {
        const latestQ: QueryResult = await (facility
          ? server.pg.query(
              `SELECT value FROM honeycomb_triggers WHERE deployment = $1 AND facility = $2 AND hook = $3 ORDER BY timestamp DESC LIMIT 1`,
              [deployment, facility, hook]
            )
          : server.pg.query(
              `SELECT value FROM honeycomb_triggers WHERE deployment = $1 AND facility IS NULL AND hook = $2 ORDER BY timestamp DESC LIMIT 1`,
              [deployment, hook]
            ));
        const latest: number[] = latestQ.rows[0]?.value;
        facData.set(hook, latest);
      }

      if (facData.size > 0) depData.set(facility, facData);
    }

    if (depData.size > 0) data.set(deployment, depData);
  }

  console.log(data);

  const allHooksQ: QueryResult = await server.pg.query(
    `SELECT allh.hook FROM (
      SELECT DISTINCT hook FROM honeycomb_triggers WHERE hook IS NOT NULL
    ) allh
    LEFT JOIN trigger_descriptions td ON allh.hook = td.hook
    ORDER BY td."order" ASC`
  );
  const allHooks: string[] = allHooksQ.rows.map((row) => row.hook);

  const hookDescriptionsQ: QueryResult = await server.pg.query(
    `SELECT hook, description, threshold FROM trigger_descriptions`
  );
  const hookDescriptions: Map<
    string,
    {
      description: string;
      threshold: number;
    }
  > = new Map(
    hookDescriptionsQ.rows.map(({ hook, description, threshold }) => [
      hook,
      { description, threshold },
    ])
  );

  return reply.view("/templates/view.ejs", {
    data,
    allHooks,
    hookDescriptions,
  });
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
      .filter(({ Group: { deployment } }) => deployment)
      .map(
        ({
          Group: { deployment, facility },
          Result,
        }): {
          deployment: string;
          facility?: string;
          value: number;
        } => ({ deployment, facility, value: Result })
      );

    console.log("Writing items to DB", {
      count: items.length,
      hookKey,
    });
    await server.pg.transact(async (client) => {
      await Promise.all(
        items.map(({ deployment, facility, value }) =>
          client.query(
            "INSERT INTO honeycomb_triggers (hook, deployment, facility, value) VALUES ($1, $2, $3, $4)",
            [hookKey, deployment, facility, value]
          )
        )
      );
    });
    console.log("Done writing");

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
    console.log("Creating schema");
    await client.query(`CREATE TABLE IF NOT EXISTS honeycomb_triggers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      hook text NOT NULL,
      deployment text NOT NULL,
      facility text NULL,
      value integer NOT NULL
    )`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS honeycomb_triggers_hook ON honeycomb_triggers (hook)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS honeycomb_triggers_deployment ON honeycomb_triggers (deployment)`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS honeycomb_triggers_facility ON honeycomb_triggers (deployment, facility)`
    );
    await client.query(`CREATE TABLE IF NOT EXISTS trigger_descriptions (
      hook text NOT NULL PRIMARY KEY,
      "order" integer NOT NULL,
      description text NOT NULL,
      threshold integer NOT NULL
    )`);
    await client.query(`TRUNCATE TABLE trigger_descriptions`);
    await client.query(`
      INSERT INTO trigger_descriptions
      ("order", hook, description, threshold)
      VALUES
      (1, 'error-rate', 'Errors per minute', 10),
      (2, 'email-queue-size', 'Email backlog', 50),
      (3, 'certnotif-queue-size', 'Certificate notification backlog', 20)
    `);
  } catch (err) {
    console.error(err);
    throw err;
  } finally {
    client.release();
  }

  console.log(`Server listening at ${address}`);
});
