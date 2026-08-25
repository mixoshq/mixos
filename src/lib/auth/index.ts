import NextAuth from "next-auth";
import { buildAuthOptions } from "./config";

export const { auth, handlers, signIn, signOut } = NextAuth(async () =>
  buildAuthOptions()
);
