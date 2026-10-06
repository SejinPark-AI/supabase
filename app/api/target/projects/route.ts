import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ManagementError, TOKEN_COOKIE, listProjects } from "@/lib/management";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const projects = await listProjects(token);
    return NextResponse.json({ projects });
  } catch (e) {
    const status = e instanceof ManagementError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
