package com.jeopardy.api.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "jeopardy.auth")
public class AuthProperties {

    private boolean enabled = true;
    private String provider = "local"; // local | azure-ad
    private String adminUsername = "admin";
    private String adminPassword = "admin123";
    private String jwtSecret = "jeopardy-local-dev-signing-secret-change-in-prod-32bytes";
    private int sessionTtlHours = 12;
    private boolean cookieSecure = false;
    private AzureAd azureAd = new AzureAd();

    public static class AzureAd {
        private String tenantId = "";
        private String clientId = "";
        private String adminRole = "Jeopardy.Admin";
        private String operatorRole = "Jeopardy.Operator";

        public String getTenantId() {
            return tenantId;
        }

        public void setTenantId(String tenantId) {
            this.tenantId = tenantId;
        }

        public String getClientId() {
            return clientId;
        }

        public void setClientId(String clientId) {
            this.clientId = clientId;
        }

        public String getAdminRole() {
            return adminRole;
        }

        public void setAdminRole(String adminRole) {
            this.adminRole = adminRole;
        }

        public String getOperatorRole() {
            return operatorRole;
        }

        public void setOperatorRole(String operatorRole) {
            this.operatorRole = operatorRole;
        }

        public boolean isConfigured() {
            return tenantId != null && !tenantId.isBlank()
                    && clientId != null && !clientId.isBlank();
        }
    }

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getProvider() {
        return provider;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public String getAdminUsername() {
        return adminUsername;
    }

    public void setAdminUsername(String adminUsername) {
        this.adminUsername = adminUsername;
    }

    public String getAdminPassword() {
        return adminPassword;
    }

    public void setAdminPassword(String adminPassword) {
        this.adminPassword = adminPassword;
    }

    public String getJwtSecret() {
        return jwtSecret;
    }

    public void setJwtSecret(String jwtSecret) {
        this.jwtSecret = jwtSecret;
    }

    public int getSessionTtlHours() {
        return sessionTtlHours;
    }

    public void setSessionTtlHours(int sessionTtlHours) {
        this.sessionTtlHours = sessionTtlHours;
    }

    public boolean isCookieSecure() {
        return cookieSecure;
    }

    public void setCookieSecure(boolean cookieSecure) {
        this.cookieSecure = cookieSecure;
    }

    public AzureAd getAzureAd() {
        return azureAd;
    }

    public void setAzureAd(AzureAd azureAd) {
        this.azureAd = azureAd;
    }
}
