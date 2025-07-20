import { Injectable } from "@nestjs/common";
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
            throw error;
        }
    }
}
