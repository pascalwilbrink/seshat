import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';

interface Res {
  status(code: number): Res;
  json(body: unknown): unknown;
}

/**
 * Last-resort filter for unexpected errors. Responds with a fixed 500 and logs only the error's class name,
 * never its message, stack or the request: those can carry credentials, cookies or driver details.
 */
@Catch()
export class SanitizedExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Res>();
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    this.logger.error(`Unhandled error (${exception instanceof Error ? exception.name : 'unknown'})`);
    res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}
