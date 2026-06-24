package com.fling.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

// [RUNTIME STABILITY FIX] Bind this app's network traffic to the active
// Wi-Fi link, even when that Wi-Fi has no internet access.
//
// WHY THIS IS NEEDED:
//   A Ranger node runs its own Wi-Fi hotspot with NO internet, by design.
//   When the phone also has mobile data active (the normal case — most
//   people don't turn off cellular data just to use this app), Android's
//   default network selection prefers the internet-VALIDATED network for any
//   socket that isn't explicitly bound to a specific network. That means the
//   WebView's WebSocket connection to ws://192.168.4.1:8765 was silently
//   going out over the cellular interface — where that private address is
//   simply unreachable — even while the phone shows as "connected" to the
//   Ranger Wi-Fi in Android's settings. The app would then sit at "Retry
//   Connection" forever, with no error that points at the real cause.
//
// THE FIX:
//   Request any available Wi-Fi network — explicitly NOT requiring internet
//   capability, since the Ranger AP intentionally has none — and bind this
//   whole process to it with ConnectivityManager.bindProcessToNetwork(). That
//   makes every socket the app opens (including the WebView's) prefer that
//   Wi-Fi link regardless of whatever higher-priority validated network also
//   exists. If the Wi-Fi link is lost, the binding is released back to
//   normal default-network selection so the rest of the device keeps working
//   normally until the next Ranger Wi-Fi connection becomes available.
public class MainActivity extends BridgeActivity {

    private ConnectivityManager.NetworkCallback wifiNetworkCallback;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bindToWifiNetwork();
    }

    private void bindToWifiNetwork() {
        ConnectivityManager connectivityManager =
            (ConnectivityManager) getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null) return;

        NetworkRequest request = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();

        wifiNetworkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                super.onAvailable(network);
                connectivityManager.bindProcessToNetwork(network);
            }

            @Override
            public void onLost(Network network) {
                super.onLost(network);
                // Wi-Fi link gone — release the binding so the rest of the
                // app isn't stuck pinned to a network that no longer exists.
                // A fresh onAvailable() will rebind once Wi-Fi reconnects.
                connectivityManager.bindProcessToNetwork(null);
            }
        };

        connectivityManager.requestNetwork(request, wifiNetworkCallback);
    }

    @Override
    public void onDestroy() {
        if (wifiNetworkCallback != null) {
            ConnectivityManager connectivityManager =
                (ConnectivityManager) getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (connectivityManager != null) {
                try {
                    connectivityManager.unregisterNetworkCallback(wifiNetworkCallback);
                } catch (IllegalArgumentException e) {
                    // Callback was already unregistered — safe to ignore.
                }
            }
        }
        super.onDestroy();
    }
}