import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as cookieParser from 'cookie-parser';
import * as cors from 'cors';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const DEV_ORIGINS = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
  ];

  app.use(cookieParser());
  app.enableCors({
    origin: (origin, cb) =>
      cb(
        null,
        origin && DEV_ORIGINS.includes(origin) ? origin : DEV_ORIGINS[0],
      ),
    credentials: true,
  });

  await app.listen(process.env.PORT || 8080);
}

bootstrap();
