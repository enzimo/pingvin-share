import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

// Account operations must never inherit the anonymous-upload exception.
@Injectable()
export class AuthenticatedGuard extends AuthGuard("jwt") {}
