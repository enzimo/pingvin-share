export interface OAuthSignInDto {
  provider: "github" | "google" | "microsoft" | "discord" | "oidc";
  providerId: string;
  providerUsername: string;
  email: string;
  emailVerified: boolean;
  isAdmin?: boolean;
  idToken?: string;
}
