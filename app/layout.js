import './globals.css';
import Header from '@/components/Header';

export const metadata = {
  title: "Ted's Tools",
  description: 'Personal dashboard for tools, notes and links.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="flex flex-col h-screen overflow-hidden bg-bg text-text font-sans">
        <Header />
        <main className="flex-1 min-h-0 min-w-0 flex flex-col md:flex-row">{children}</main>
      </body>
    </html>
  );
}
