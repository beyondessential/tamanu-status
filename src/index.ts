import AWS from 'aws-sdk';
import fastify from 'fastify';
import * as yup from 'yup';

const dyndb = new AWS.DynamoDB({ apiVersion: '2012-08-10' });
const server = fastify();

server.get('/', async (request, reply) => {
  return 'pong';
});

const HOOK_SCHEMA = yup.object({
  version: yup.string().required().oneOf(['v0.1.0']),
  shared_secret: yup.string().optional(),
  name: yup.string().required(),
  trigger_description: yup.string().required().matches(/^status:[a-z0-9-]+$/),
  result_url: yup.string().url().required(),
  result_groups: yup.array().of(yup.object({
    Group: yup.object().required(),
    Result: yup.mixed().required(),
  })).required(),
});

const HOOK_SECRET = process.env.HONEYCOMB_HOOK_SECRET;
server.post('/hook/honeycomb', async (request, reply) => {
  try {
    const hook = await HOOK_SCHEMA.validate(request.body);

    if (!HOOK_SECRET) {
      console.warn('Accepting ALL hooks regardless of secret!');
    } else if (!hook.shared_secret) {
      console.warn('No shared secret on hook!');
    } else if (HOOK_SECRET !== hook.shared_secret) {
      throw new Error('Invalid shared secret');
    }

    const key = hook.trigger_description.split(':', 2)[1];
    const results = hook.result_groups;
    console.log(key, results);

    return 'gotcha';
  } catch (err) {
    console.error(err);
    throw err;
  }
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;

server.listen({ port }, (err, address) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }

  console.log(`Server listening at ${address}`)
});

