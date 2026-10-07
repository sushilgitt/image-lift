import { Icon } from "@shopify/polaris";

// Page title row shown at the top of each feature page. `aside` renders on the
// right (e.g. a status pill or primary action).
export default function PageHeader({ icon, eyebrow, title, subtitle, aside }) {
  return (
    <div className="il-page-header">
      <span className="il-page-header-icon">
        <Icon source={icon} />
      </span>
      <div className="il-page-header-text">
        {eyebrow && <p className="il-page-header-eyebrow">{eyebrow}</p>}
        <h1 className="il-page-header-title">{title}</h1>
        {subtitle && <p className="il-page-header-sub">{subtitle}</p>}
      </div>
      {aside && <div className="il-page-header-aside">{aside}</div>}
    </div>
  );
}
