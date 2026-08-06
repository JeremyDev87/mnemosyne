import { redirect } from "next/navigation";

export default function ProtectedLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  redirect("/login");
  return children;
}
