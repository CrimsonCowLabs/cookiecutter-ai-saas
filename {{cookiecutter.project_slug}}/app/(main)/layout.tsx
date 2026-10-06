import { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { getSEOTags, renderSchemaTags } from "@/lib/seo";
import ClientLayout from "@/components/LayoutClient";
import { SkipLink } from "@/components/ui/skip-link";
import config from "@/config";
import "../globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata = getSEOTags();

export default function MainLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme={config.colors.theme}
      className={`${inter.variable} ${jetbrains.variable} ${inter.className}`}
    >
      <head>
        {renderSchemaTags()}
      </head>
      <body>
        <SkipLink />
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
