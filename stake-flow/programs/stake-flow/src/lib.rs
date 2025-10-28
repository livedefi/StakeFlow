use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_lang::solana_program::program_option::COption;

declare_id!("4cUDbCQvhBSzWbTivv3ZscDkePVweqRFAHbgDUKLkfdK");

const SECONDS_PER_YEAR: i64 = 31_536_000;

fn calc_rewards(staked_amount: u64, elapsed_seconds: i64, apr_bps: u16) -> u64 {
    if elapsed_seconds <= 0 || staked_amount == 0 || apr_bps == 0 {
        return 0;
    }
    let num = (staked_amount as u128) * (elapsed_seconds as u128) * (apr_bps as u128);
    let denom = (SECONDS_PER_YEAR as u128) * 10_000u128;
    (num / denom) as u64
}

#[program]
pub mod stake_flow {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        apr_bps: u16,
        min_lock_duration: i64,
        early_unstake_penalty_bps: u16,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.stake_mint = ctx.accounts.stake_mint.key();
        config.reward_mint = ctx.accounts.reward_mint.key();
        config.apr_bps = apr_bps;
        config.min_lock_duration = min_lock_duration;
        config.early_unstake_penalty_bps = early_unstake_penalty_bps;

        config.bump = ctx.bumps.config;
        config.stake_vault_bump = ctx.bumps.stake_vault;
        config.penalty_vault_bump = ctx.bumps.penalty_vault;

        let (_auth, auth_bump) =
            Pubkey::find_program_address(&[b"reward_mint_authority"], ctx.program_id);
        config.reward_mint_auth_bump = auth_bump;

        // Ensure current mint authority is the admin, then assign PDA as new mint authority
        match ctx.accounts.reward_mint.mint_authority {
            COption::Some(current) => {
                require!(current == ctx.accounts.admin.key(), StakeFlowError::Unauthorized);
            }
            COption::None => return Err(error!(StakeFlowError::InvalidMint)),
        }
        let cpi_accounts = anchor_spl::token::SetAuthority {
            account_or_mint: ctx.accounts.reward_mint.to_account_info(),
            current_authority: ctx.accounts.admin.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::set_authority(
            CpiContext::new(cpi_program, cpi_accounts),
            AuthorityType::MintTokens,
            Some(ctx.accounts.reward_mint_authority.key()),
        )?;

        Ok(())
    }

    pub fn create_user_stake(ctx: Context<CreateUserStake>) -> Result<()> {
        let user = &mut ctx.accounts.user_stake;
        user.owner = ctx.accounts.owner.key();
        user.staked_amount = 0;
        user.pending_rewards = 0;
        user.last_update_ts = Clock::get()?.unix_timestamp;
        user.lock_until_ts = 0;
        user.bump = ctx.bumps.user_stake;
        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakeFlowError::InvalidAmount);
        let owner = &ctx.accounts.owner;
        let config = &ctx.accounts.config;
        let user = &mut ctx.accounts.user_stake;
        let owner_ata = &ctx.accounts.owner_stake_ata;
        let vault = &ctx.accounts.stake_vault;

        require!(owner_ata.owner == owner.key(), StakeFlowError::Unauthorized);
        require!(owner_ata.mint == config.stake_mint, StakeFlowError::InvalidMint);
        require!(vault.mint == config.stake_mint, StakeFlowError::InvalidMint);

        let now = Clock::get()?.unix_timestamp;
        let elapsed = now - user.last_update_ts;
        let accrued = calc_rewards(user.staked_amount, elapsed, config.apr_bps);
        user.pending_rewards = user.pending_rewards.saturating_add(accrued);
        user.last_update_ts = now;

        let cpi_accounts = Transfer {
            from: owner_ata.to_account_info(),
            to: vault.to_account_info(),
            authority: owner.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), amount)?;

        user.staked_amount = user.staked_amount.saturating_add(amount);
        user.lock_until_ts = now.saturating_add(config.min_lock_duration);
        emit!(StakeEvent { owner: owner.key(), amount });
        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakeFlowError::InvalidAmount);
        let owner = &ctx.accounts.owner;
        let config = &ctx.accounts.config;
        let user = &mut ctx.accounts.user_stake;
        let owner_ata = &ctx.accounts.owner_stake_ata;
        let vault = &ctx.accounts.stake_vault;
        let penalty_vault = &ctx.accounts.penalty_vault;

        require!(owner_ata.owner == owner.key(), StakeFlowError::Unauthorized);
        require!(owner_ata.mint == config.stake_mint, StakeFlowError::InvalidMint);
        require!(vault.mint == config.stake_mint, StakeFlowError::InvalidMint);
        require!(penalty_vault.mint == config.stake_mint, StakeFlowError::InvalidMint);
        require!(amount <= user.staked_amount, StakeFlowError::InsufficientStake);

        let now = Clock::get()?.unix_timestamp;
        let elapsed = now - user.last_update_ts;
        let accrued = calc_rewards(user.staked_amount, elapsed, config.apr_bps);
        user.pending_rewards = user.pending_rewards.saturating_add(accrued);
        user.last_update_ts = now;

        // Conditional penalty if lock has not expired yet
        let penalty: u64 = if now < user.lock_until_ts && config.early_unstake_penalty_bps > 0 {
            let p = (amount as u128)
                .saturating_mul(config.early_unstake_penalty_bps as u128)
                .saturating_div(10_000u128) as u64;
            p
        } else {
            0
        };
        let net = amount.saturating_sub(penalty);
        require!(net > 0, StakeFlowError::InvalidAmount);

        let seeds: &[&[u8]] = &[b"config".as_ref(), &[config.bump]];
        let signer = &[&seeds[..]];
        let cpi_program = ctx.accounts.token_program.to_account_info();

        // Transfer penalty to penalty_vault if applicable
        if penalty > 0 {
            let penalty_transfer = Transfer {
                from: vault.to_account_info(),
                to: penalty_vault.to_account_info(),
                authority: config.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(cpi_program.clone(), penalty_transfer, signer),
                penalty,
            )?;
        }

        // Transfer net amount to user
        let net_transfer = Transfer {
            from: vault.to_account_info(),
            to: owner_ata.to_account_info(),
            authority: config.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(cpi_program, net_transfer, signer),
            net,
        )?;

        user.staked_amount = user.staked_amount.saturating_sub(amount);
        if user.staked_amount == 0 { user.lock_until_ts = 0; }

        emit!(UnstakeEvent { owner: owner.key(), amount, penalty });
        Ok(())
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        let owner = &ctx.accounts.owner;
        let config = &ctx.accounts.config;
        let user = &mut ctx.accounts.user_stake;
        let reward_mint = &ctx.accounts.reward_mint;
        let owner_reward_ata = &ctx.accounts.owner_reward_ata;

        require!(reward_mint.key() == config.reward_mint, StakeFlowError::InvalidMint);
        require!(owner_reward_ata.owner == owner.key(), StakeFlowError::Unauthorized);
        require!(owner_reward_ata.mint == config.reward_mint, StakeFlowError::InvalidMint);

        // Ensure the mint authority is the PDA we expect
        match reward_mint.mint_authority {
            COption::Some(pk) => {
                require!(pk == ctx.accounts.reward_mint_authority.key(), StakeFlowError::Unauthorized)
            }
            COption::None => return Err(error!(StakeFlowError::InvalidMint)),
        }

        let now = Clock::get()?.unix_timestamp;
        let elapsed = now - user.last_update_ts;
        let accrued = calc_rewards(user.staked_amount, elapsed, config.apr_bps);
        let total = user.pending_rewards.saturating_add(accrued);
        require!(total > 0, StakeFlowError::InvalidAmount);

        let seeds: &[&[u8]] = &[b"reward_mint_authority".as_ref(), &[config.reward_mint_auth_bump]];
        let signer = &[&seeds[..]];

        let cpi_accounts = MintTo {
            mint: reward_mint.to_account_info(),
            to: owner_reward_ata.to_account_info(),
            authority: ctx.accounts.reward_mint_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::mint_to(CpiContext::new_with_signer(cpi_program, cpi_accounts, signer), total)?;

        user.pending_rewards = 0;
        user.last_update_ts = now;
        emit!(ClaimEvent { owner: owner.key(), rewards: total });
        Ok(())
    }

    pub fn update_params(
        ctx: Context<UpdateParams>,
        apr_bps: Option<u16>,
        min_lock_duration: Option<i64>,
        early_unstake_penalty_bps: Option<u16>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(ctx.accounts.admin.key() == config.admin, StakeFlowError::Unauthorized);
        if let Some(v) = apr_bps {
            config.apr_bps = v;
        }
        if let Some(v) = min_lock_duration {
            require!(v >= 0, StakeFlowError::InvalidAmount);
            config.min_lock_duration = v;
        }
        if let Some(v) = early_unstake_penalty_bps {
            require!(v <= 10_000, StakeFlowError::InvalidAmount);
            config.early_unstake_penalty_bps = v;
        }
        Ok(())
    }

    pub fn close_user_stake(ctx: Context<CloseUserStake>) -> Result<()> {
        let user = &ctx.accounts.user_stake;
        require!(user.owner == ctx.accounts.owner.key(), StakeFlowError::Unauthorized);
        require!(user.staked_amount == 0 && user.pending_rewards == 0, StakeFlowError::NotClosable);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub stake_mint: Account<'info, Mint>,
    #[account(mut)]
    pub reward_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [b"config"],
        bump,
        space = 8 + Config::SIZE,
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        seeds = [b"stake_vault", config.key().as_ref()],
        bump,
        token::mint = stake_mint,
        token::authority = config,
    )]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        seeds = [b"penalty_vault", config.key().as_ref()],
        bump,
        token::mint = stake_mint,
        token::authority = config,
    )]
    pub penalty_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        seeds = [b"reward_mint_authority"],
        bump,
        space = 8,
    )]
    pub reward_mint_authority: Account<'info, RewardMintAuthority>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateUserStake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = owner,
        seeds = [b"user", owner.key().as_ref()],
        bump,
        space = 8 + UserStake::SIZE,
    )]
    pub user_stake: Account<'info, UserStake>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"stake_vault", config.key().as_ref()], bump = config.stake_vault_bump)]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_stake_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"user", owner.key().as_ref()], bump = user_stake.bump)]
    pub user_stake: Account<'info, UserStake>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"stake_vault", config.key().as_ref()], bump = config.stake_vault_bump)]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_stake_ata: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"user", owner.key().as_ref()], bump = user_stake.bump)]
    pub user_stake: Account<'info, UserStake>,
    #[account(mut, seeds = [b"penalty_vault", config.key().as_ref()], bump = config.penalty_vault_bump)]
    pub penalty_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"user", owner.key().as_ref()], bump = user_stake.bump)]
    pub user_stake: Account<'info, UserStake>,
    #[account(seeds = [b"reward_mint_authority"], bump = config.reward_mint_auth_bump)]
    pub reward_mint_authority: Account<'info, RewardMintAuthority>,
    #[account(mut)]
    pub reward_mint: Account<'info, Mint>,
    #[account(mut)]
    pub owner_reward_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct CloseUserStake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, close = owner, seeds = [b"user", owner.key().as_ref()], bump = user_stake.bump)]
    pub user_stake: Account<'info, UserStake>,
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub stake_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub apr_bps: u16,
    pub min_lock_duration: i64,
    pub early_unstake_penalty_bps: u16,
    pub bump: u8,
    pub stake_vault_bump: u8,
    pub penalty_vault_bump: u8,
    pub reward_mint_auth_bump: u8,
}

impl Config {
    pub const SIZE: usize = 32 + 32 + 32 + 2 + 8 + 2 + 1 + 1 + 1 + 1;
}

#[account]
pub struct UserStake {
    pub owner: Pubkey,
    pub staked_amount: u64,
    pub pending_rewards: u64,
    pub last_update_ts: i64,
    pub lock_until_ts: i64,
    pub bump: u8,
}

impl UserStake {
    pub const SIZE: usize = 32 + 8 + 8 + 8 + 8 + 1;
}

#[error_code]
pub enum StakeFlowError {
    #[msg("Unauthorized")] Unauthorized,
    #[msg("Invalid mint")] InvalidMint,
    #[msg("Insufficient staked amount")] InsufficientStake,
    #[msg("Invalid amount")] InvalidAmount,
    #[msg("Account not closable")] NotClosable,
}

#[event]
pub struct StakeEvent {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct UnstakeEvent {
    pub owner: Pubkey,
    pub amount: u64,
    pub penalty: u64,
}

#[event]
pub struct ClaimEvent {
    pub owner: Pubkey,
    pub rewards: u64,
}

#[account]
pub struct RewardMintAuthority {}
