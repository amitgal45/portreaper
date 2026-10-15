import { createApp } from "vue";
import "../style.css";
import { provideFixture } from "./fixtures";
import QuickApp from "./QuickApp.vue";

// The e2e measures first paint from here: `performance.measure("quick", "quick:start", <first rows>)`.
performance.mark("quick:start");

const app = createApp(QuickApp);
provideFixture(app, location.search);
app.mount("#quick");
