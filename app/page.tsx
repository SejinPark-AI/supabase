import Migrator from "@/components/Migrator";

export default function Home() {
  return (
    <Migrator
      defaultUrl={process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}
      defaultAnonKey={process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""}
    />
  );
}
