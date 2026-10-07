import { redirect } from "react-router";
import styles from "./styles.module.css";
import { LiftMark } from "../../components/Brand";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // No shop-domain form: App Store apps must be installed and opened from
  // Shopify (App Store / admin), never by typing a myshopify.com URL here.
  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.glow} aria-hidden="true" />
      <main className={styles.content}>
        <section className={styles.intro}>
          <p className={styles.eyebrow}>
            <LiftMark size={22} />
            Image Lift
          </p>
          <h1 className={styles.heading}>
            Lighter images.
            <br />
            <span>Faster store.</span>
          </h1>
          <p className={styles.text}>
            Image optimization, AI alt text and speed insights for Shopify product photos, so every
            page loads quicker and ranks better.
          </p>
          <p className={styles.note}>
            Install Image Lift from the Shopify App Store, then open it from Apps in your Shopify admin.
          </p>
        </section>

        <ul className={styles.list}>
          <li>
            <span className={styles.num}>01</span>
            <strong>Image Optimizer</strong>
            Photos are converted to lightweight WebP and replaced directly on each product.
          </li>
          <li>
            <span className={styles.num}>02</span>
            <strong>AI Alt Text</strong>
            AI describes every product photo so shoppers and search engines understand it.
          </li>
          <li>
            <span className={styles.num}>03</span>
            <strong>Speed Insights</strong>
            Run Lighthouse tests and see exactly how much weight each page has lost.
          </li>
        </ul>
      </main>
    </div>
  );
}

