import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const DEV_ORIGINS = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
  ];

  app.use(cookieParser());
  app.enableCors({
    origin: (origin: string, cb: (arg0: null, arg1: any) => any) =>
      cb(
        null,
        origin && DEV_ORIGINS.includes(origin) ? origin : DEV_ORIGINS[0],
      ),
    credentials: true,
  });

  const config = new DocumentBuilder()
    .setTitle('Algotcha API')
    .setDescription('API docs for Auth, Comments, Exchange')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(process.env.PORT || 8080);
}

bootstrap();
