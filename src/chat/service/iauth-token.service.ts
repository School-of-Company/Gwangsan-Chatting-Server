import { memberInfo } from "../dto/chat-member-info.dto";

export interface IAuthTokenService {
    execute(token: string): Promise<memberInfo>;
}