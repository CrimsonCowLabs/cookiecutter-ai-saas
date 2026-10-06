import { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Navbar } from "@/components/ui/navbar";
import { Footer } from "@/components/ui/footer";
import { BlogCard } from "@/components/blog/blog-card";
import fs from "fs";
import path from "path";
import { Main } from "@/components/ui/skip-link";

export const metadata: Metadata = {
  title: "Blog | __PROJECT_NAME__",
  description: "Insights, tutorials, and updates from the __PROJECT_NAME__ team.",
  alternates: {
    canonical: "https://__DOMAIN_NAME__/blog",
  },
};

interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  tags: string[];
  publishedAt: string;
  featuredImage: string | null;
  content: string;
}

function loadBlogPosts(): BlogPost[] {
  const contentDir = path.join(process.cwd(), "content", "blog");

  try {
    const files = fs.readdirSync(contentDir).filter((f) => f.endsWith(".json"));
    const posts = files.map((file) => {
      const raw = fs.readFileSync(path.join(contentDir, file), "utf-8");
      return JSON.parse(raw) as BlogPost;
    });

    // Sort by date descending
    return posts.sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
  } catch {
    return [];
  }
}

function ArrowLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

export default function BlogPage() {
  const posts = loadBlogPosts();

  return (
    <div className="min-h-screen bg-base-100 relative overflow-hidden">
      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute -top-48 -left-48 w-[600px] h-[600px] rounded-full bg-primary/[0.04] blur-3xl" />
        <div className="absolute -bottom-48 -right-48 w-[500px] h-[500px] rounded-full bg-emerald-500/[0.03] blur-3xl" />
      </div>

      <Navbar />

      <Main className="relative z-10 max-w-6xl mx-auto px-6 py-16">
        {/* Back to home */}
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-base-content/70 hover:text-base-content transition-colors mb-8"
        >
          <ArrowLeftIcon className="w-4 h-4" />
          Back to Home
        </Link>

        {/* Hero */}
        <div className="mb-16">
          <p className="text-sm font-medium text-primary mb-3 font-[family-name:var(--font-mono)]">
            {"// blog"}
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            Latest Articles
          </h1>
          <p className="text-lg text-base-content/60 mt-4 max-w-2xl">
            Tutorials, insights, and updates on AI automation. Learn how to get the most out of __PROJECT_NAME__.
          </p>
        </div>

        {/* Posts Grid */}
        {posts.length === 0 ? (
          <div className="text-center py-20 bg-base-200/50 rounded-xl border border-base-content/5">
            <div className="w-12 h-12 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mx-auto mb-4">
              <Logo className="w-6 h-6" />
            </div>
            <p className="text-base-content/60">No posts yet. Check back soon!</p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {posts.map((post) => (
              <BlogCard key={post.slug} post={post} />
            ))}
          </div>
        )}
      </Main>

      <Footer />
    </div>
  );
}
