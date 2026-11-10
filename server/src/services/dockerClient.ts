import Docker from 'dockerode';

import { env } from '../config/env.js';

export function createDockerClient(): Docker {
  if (!env.DOCKER_HOST) {
    return new Docker({ socketPath: '/var/run/docker.sock' });
  }

  const endpoint = new URL(env.DOCKER_HOST);
  return new Docker({
    host: endpoint.hostname,
    port: Number(endpoint.port),
    protocol: endpoint.protocol.replace(':', '') as 'http' | 'https',
  });
}
