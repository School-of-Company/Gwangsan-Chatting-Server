export class LoggingUtil {
    static log(context: string, message: string, ...optionalParams: any[]): void {
      console.log(`[${new Date().toISOString()}] [${context}] ${message}`, ...optionalParams);
    }
  
    static error(context: string, message: string, ...optionalParams: any[]): void {
      console.error(`[${new Date().toISOString()}] [${context}] ERROR: ${message}`, ...optionalParams);
    }
  }
  