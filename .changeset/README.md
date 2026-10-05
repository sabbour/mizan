# Changesets

The root `mizan` package tracks the MSIX release version; the `ui` package has
its own unrelated development version. Add a `mizan` patch/minor/major
changeset for each user-facing change with `npm run changeset`. Keep several
changesets pending while iterating with dev builds; only when a release is
ready run `npm run changeset:version` **once** to group them into one root
package/changelog version and build/sign one matching MSIX. The tag-triggered
build checks that its tag equals the root package version. The package is
private because npm publishing is not how the desktop application ships;
private packages are still versioned.

Past releases are recorded in `changesets-history\` outside this folder:
placing already-shipped changesets here would incorrectly bump the next
release. Changesets `status` needs an initial Git commit before it can compare
the working tree with the base branch.

We have a quick list of common questions to get you started engaging with this project in
[our documentation](https://github.com/changesets/changesets/blob/main/docs/common-questions.md).
