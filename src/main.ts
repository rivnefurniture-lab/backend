import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Allowed origins for CORS
  const ALLOWED_ORIGINS = [
    // Local development
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    // Production - add your Vercel domains
    process.env.FRONTEND_URL,
    // Vercel preview deployments (wildcard pattern handled below)
  ].filter(Boolean);

  app.use(cookieParser());
  
  // Enable CORS with proper production support
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) {
        return callback(null, true);
      }
      
      // Check if origin is in allowed list
      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      
      // Allow all Vercel preview deployments
      if (origin.includes('.vercel.app')) {
        return callback(null, true);
      }
      
      // Allow Railway deployments
      if (origin.includes('.railway.app')) {
        return callback(null, true);
      }

      // For development, allow all origins
      if (process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }
      
      console.log('CORS blocked origin:', origin);
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
  });

  // Global validation pipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: false,
  }));

  // Swagger API docs
  const config = new DocumentBuilder()
    .setTitle('Algotcha API')
    .setDescription('Trading bot API - Backtest, Strategies, Exchange')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT || 8080;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📚 API Docs: http://localhost:${port}/docs`);
}

bootstrap();
