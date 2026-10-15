import { createApp } from "vue";
import "../style.css";
import QuickApp from "./QuickApp.vue";

// The e2e measures first paint from here: `performance.measure("quick", "quick:start", <first rows>)`.
performance.mark("quick:start");

createApp(QuickApp).mount("#quick");
