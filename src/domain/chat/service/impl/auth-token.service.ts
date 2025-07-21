import { Injectable, InternalServerErrorException, UnauthorizedException } from "@nestjs/common";
import { IAuthTokenService } from "../iauth-token.service";
import { memberInfo } from "src/domain/chat/dto/chat-member-info.dto";
import axios from "axios";

@Injectable()
export class AuthTokenService implements IAuthTokenService {

    async execute(token: string): Promise<memberInfo> {
        try {
            const response = await axios.get(
                `${process.env.SPRING_SERVER_URL}/api/auth`,
                {
                    headers: { Authorization: `${token}`},
                },
            );

            return response.data;
        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.response?.status === 401) {
                    throw new UnauthorizedException('인증에 실패했습니다.');
                }
                // 그 외 서버 에러
                throw new InternalServerErrorException('서버 내부 오류가 발생했습니다.');
            }
            throw error; // axios가 아닌 다른 에러면 그냥 던짐
        }
    }
}
