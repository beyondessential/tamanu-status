import AWS from 'aws-sdk';
import fastify from 'fastify';

const dyndb = new AWS.DynamoDB({ apiVersion: '2012-08-10' });
const server = fastify();

server.get('/', async (request, reply) => {
  return 'pong';
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;

server.listen({ port }, (err, address) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }

  console.log(`Server listening at ${address}`)
});

