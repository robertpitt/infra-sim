# Prices

`aws.json` holds AWS's prices: what each thing a design uses costs, by service, region and dimension. The simulator reads
it through `src/simulator/Pricing.ts`. It is **data, not code**: when AWS changes a price, regenerating this file is the
whole change, and its diff shows exactly what moved.

## What's in it

```jsonc
{
  "provider": "aws",
  "currency": "USD",
  "generated": "2026-10-12T21:27:22.123Z",      // moves only when a price does
  "services": {
    "lambda": {                                   // the simulator's name for the service (its folder in src/simulator/aws/)
      "title": "AWS Lambda",
      "sources": [{ "offer": "AWSLambda", "version": "20261009223122", "published": "2026-10-09T22:31:22Z", "url": "…" }],
      "dimensions": {
        "duration/arm64": {                       // one thing billed by the unit
          "unit": "GB-second",
          "description": "Duration on Arm (Graviton), by memory configured",
          "free": 400000,                         // free each month, for the account
          "regions": {
            "eu-west-1": [[0, 0.0000133334], [7500000000, 0.0000120001], [18750000000, 0.0000106667]],
            "us-east-1": 0.0000133334             // a flat price, or tiers by the month's use: [[from, price], …]
          }
        }
      }
    }
  }
}
```

- **Dimensions** are named for what a meter in the simulator counts: `requests`, `duration/arm64`, `instance/m7g.large`,
  `storage`. A service priced the same everywhere (Route 53) lists its prices under `global`.
- **Tiers** are counted in units used that month, free ones included. `Pricing.cost` applies the free allowance first,
  then each tier in turn.
- **`freeShared`** names a free allowance several dimensions share: Lambda's 400,000 GB-seconds cover both
  architectures, and CloudFront's free terabyte covers every geography. A meter adds up the group's use.
- **A dimension missing from a region** usually means AWS doesn't sell it there: an instance type, or SES in a newer
  region. A lookup there returns `undefined`, which is not the same as free.
- **`sources`** say which AWS price list each service came from and when AWS published it. Git history keeps the rest.
- **Not included:** taxes, Savings Plans, reserved capacity, Spot, and negotiated discounts. These are on-demand list
  prices, for estimates; AWS's pricing pages and your bill are the authority.

## Updating it

```bash
npm run pricing                                   # every service, every region the simulator has
npm run pricing -- lambda dynamodb                # just these; the rest of the file is kept
npm run pricing -- --regions eu-west-1 lambda     # just these regions of these services
npm run pricing -- --check                        # fetch and compare, write nothing
npm run pricing -- --verbose                      # also list each dimension missing from some regions
```

The generator, `tools/pricing/`, reads AWS's public
[Price List bulk files](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api.html).
It needs no credentials. It prints, per service, how many prices changed. Files are cached in `.tmp/pricing-cache/` by
AWS's version, so a second run only fetches what AWS has republished.

## Adding a service, or a dimension

Each service has a mapping in `tools/pricing/services/<id>.ts` saying which of AWS's price rows is which dimension.
`lambda.ts` is the reference. A mapping changes only when AWS renames a usage type, never when a price changes.

To see what a price file holds while you write one:

```bash
npm run pricing -- --explore AmazonDynamoDB eu-west-1 [text]
npm run pricing -- --explore AmazonRDS us-east-1 db.r7g --columns "Database Engine,Deployment Option"
```

Usage types arrive without their region prefix (`EUW2-Request-ARM` becomes `Request-ARM`). Match on them, and on the
CSV's own column names (`Instance Type`, `Operating System`, `Queue Type`) where a usage type alone is ambiguous.

The generator is strict, so a mapping mistake fails it instead of putting a wrong price in the file. It fails on:
- two rows pricing the same units differently;
- tiers that don't meet;
- units that don't agree;
- a declared dimension that no row priced.

## Other sources

The catalog's format doesn't depend on where prices come from. Another source only has to produce rows for the same
mappings, or write the format directly. That covers the AWS Price List Query API (`aws pricing get-products`, which
needs credentials) or a file of your own negotiated prices.
