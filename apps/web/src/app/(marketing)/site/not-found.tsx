import { marketingLinks } from "@/lib/marketing/links";
import { Container, LinkButton } from "./_components/primitives";

export default async function MarketingNotFound() {
  const { href } = await marketingLinks();
  return (
    <Container className="py-24 text-center sm:py-32">
      <p className="text-meta font-semibold text-muted-foreground">404</p>
      <h1 className="display mt-3 text-3xl sm:text-4xl">That page is not here.</h1>
      <p className="mt-4 text-muted-foreground">The link may be old, or the project may have moved. Everything we have built is on the work page.</p>
      <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
        <LinkButton href={href("/work")}>See our work</LinkButton>
        <LinkButton href={href("/")} variant="secondary">
          Home
        </LinkButton>
      </div>
    </Container>
  );
}
