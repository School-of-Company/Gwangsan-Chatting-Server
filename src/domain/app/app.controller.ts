import { Controller, Get } from '@nestjs/common';

@Controller('api/health')
export class AppController {

    @Get('/check')
    async health() {
        return 'ok';
    }
}
