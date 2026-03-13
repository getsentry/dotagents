import { NextResponse, type NextRequest } from "next/server";

export const config = {
  matcher: "/",
};

export function middleware(request: NextRequest) {
  if (request.method !== "GET") {
    return NextResponse.next();
  }

  const accept = request.headers.get("accept") || "";
  const types = accept.split(",").map((t) => t.trim().split(";")[0].trim());
  const mdIndex = types.findIndex(
    (t) => t === "text/markdown" || t === "text/x-markdown",
  );
  const htmlIndex = types.findIndex((t) => t === "text/html");

  // Prefer markdown if it appears before text/html (or html is absent)
  if (mdIndex !== -1 && (htmlIndex === -1 || mdIndex < htmlIndex)) {
    return NextResponse.rewrite(new URL("/llms.txt", request.url));
  }

  return NextResponse.next();
}
