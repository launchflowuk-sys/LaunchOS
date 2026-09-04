export interface CmsContentChange { siteRef: string; path: string; contentMd: string }
export interface CmsContentResult { revisionId: string; applied: boolean }
export interface CmsProvider { readonly name: "mock-cms" | "wordpress"; updateContent(input: CmsContentChange): Promise<CmsContentResult> }

/**
 * Records what it was asked to change and reports success. The real WordPress
 * client needs per-site REST credentials and is a reported external blocker.
 */
export class MockCmsProvider implements CmsProvider {
  readonly name = "mock-cms" as const;
  readonly changes: CmsContentChange[] = [];
  async updateContent(input: CmsContentChange): Promise<CmsContentResult> {
    this.changes.push(input);
    return { revisionId: `mock-cms-${this.changes.length}`, applied: true };
  }
}
