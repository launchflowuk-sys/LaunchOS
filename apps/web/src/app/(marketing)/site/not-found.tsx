import { marketingLinks } from "@/lib/marketing/links";
import { Btn, Container, Eyebrow } from "./_components/primitives";

export default async function MarketingNotFound() {
  const { href } = await marketingLinks();
  return (
    <Container className="py-24 text-center sm:py-32">
      <Eyebrow className="justify-center">404</Eyebrow>
      <h1 className="h-section mt-5">That page is not here.</h1>
      <p className="lede mx-auto mt-5">The link may be old, or the project may have moved. Everything we have built is on the work page.</p>
      <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
        <Btn href={href("/work")} tone="ink">
          See our work
        </Btn>
        <Btn href={href("/")} tone="white" arrow={false}>
          Home
        </Btn>
      </div>
    </Container>
  );
}
