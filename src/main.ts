import './load-env';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { networkInterfaces } from 'node:os';

import { AppModule } from './app.module';
import { gzipJsonResponses } from './http/gzip-json';
import { privateApiCache } from './http/private-cache';

function lanAddresses(port: number): string[] {
  const urls = [`http://127.0.0.1:${port}`];
  for (const adapters of Object.values(networkInterfaces())) {
    for (const net of adapters ?? []) {
      if (net.family !== 'IPv4' || net.internal) {
        continue;
      }
      urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const logger = new Logger('Bootstrap');

  app.enableCors();
  app.use(privateApiCache);
  app.use(gzipJsonResponses);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  for (const url of lanAddresses(port)) {
    logger.log(`API ready  ${url}/health`);
  }
}

void bootstrap();
