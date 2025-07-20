import { Injectable } from "@nestjs/common";
import { IAuthTokenService } from "../iauth-token.service";
import { memberInfo } from "src/chat/dto/chat-member-info.dto";
import axios from "axios";

@Injectable()
export class AuthTokenService implements IAuthTokenService {

    async execute(token: string): Promise<memberInfo> {
        console.log(`[AuthTokenService] Sending request to Spring /api/auth with token: ${token}`);

        try {
            const response = await axios.get(
                `${process.env.SPRING_SERVER_URL}/api/auth`,
                {
                    headers: { Authorization: `${token}`},
                },
            );

            console.log('[AuthTokenService] Received response from Spring:', response.data);
            return response.data;
        } catch (error) {
            console.error('[AuthTokenService] Error calling Spring /api/auth:', error);
            throw error;
        }
    }
}
